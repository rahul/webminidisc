import {
    openNewDevice,
    NetMDInterface,
    Disc,
    listContent,
    openPairedDevice,
    Wireformat,
    MDTrack,
    download,
    getDeviceStatus,
    DeviceStatus,
} from 'netmd-js';
import { makeGetAsyncPacketIteratorOnWorkerThread } from 'netmd-js/dist/web-encrypt-worker';
import { Logger } from 'netmd-js/dist/logger';
import { asyncMutex, sanitizeTitle, sleep } from '../utils';
import { Mutex } from 'async-mutex';

const Worker = require('worker-loader!netmd-js/dist/web-encrypt-worker.js'); // eslint-disable-line import/no-webpack-loader-syntax

export interface NetMDService {
    mutex: Mutex;
    getDeviceStatus(): Promise<DeviceStatus>;
    pair(): Promise<boolean>;
    connect(): Promise<boolean>;
    listContent(): Promise<Disc>;
    getDeviceName(): Promise<string>;
    finalize(): Promise<void>;
    renameTrack(index: number, newTitle: string): Promise<void>;
    renameDisc(newName: string): Promise<void>;
    deleteTrack(index: number): Promise<void>;
    moveTrack(src: number, dst: number): Promise<void>;
    wipeDisc(): Promise<void>;
    upload(
        title: string,
        data: ArrayBuffer,
        format: Wireformat,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ): Promise<void>;

    play(): Promise<void>;
    pause(): Promise<void>;
    stop(): Promise<void>;
    next(): Promise<void>;
    prev(): Promise<void>;
    gotoTrack(index: number): Promise<void>;
    getPosition(): Promise<number[] | null>;
}

export class NetMDUSBService implements NetMDService {
    private netmdInterface?: NetMDInterface;
    private logger?: Logger;
    public mutex = new Mutex();
    public statusMonitorTimer: any;

    constructor({ debug = false }: { debug: boolean }) {
        if (debug) {
            // Logging a few methods that have been causing issues with some units
            const _fn = (...args: any) => {
                if (args && args[0] && args[0].method) {
                    console.log(...args);
                }
            };
            this.logger = {
                debug: _fn,
                info: _fn,
                warn: _fn,
                error: _fn,
                child: () => this.logger!,
            };
        }
    }

    async pair() {
        let iface = await openNewDevice(navigator.usb, this.logger);
        if (iface === null) {
            return false;
        }
        this.netmdInterface = iface;
        return true;
    }

    async connect() {
        let iface = await openPairedDevice(navigator.usb, this.logger);
        if (iface === null) {
            return false;
        }
        this.netmdInterface = iface;
        return true;
    }

    @asyncMutex
    async listContent() {
        return await listContent(this.netmdInterface!);
    }

    @asyncMutex
    async getDeviceStatus() {
        return await getDeviceStatus(this.netmdInterface!);
    }

    @asyncMutex
    async getDeviceName() {
        return await this.netmdInterface!.netMd.getDeviceName();
    }

    @asyncMutex
    async finalize() {
        await this.netmdInterface!.netMd.finalize();
    }

    @asyncMutex
    async renameTrack(index: number, title: string) {
        // Removing non ascii chars... Sorry, I didn't implement char encoding.
        title = sanitizeTitle(title);
        await this.netmdInterface!.cacheTOC();
        await this.netmdInterface!.setTrackTitle(index, title);
        await this.netmdInterface!.syncTOC();
    }

    @asyncMutex
    async renameDisc(newName: string) {
        // TODO: This whole function should be moved in netmd-js
        const oldName = await this.netmdInterface!.getDiscTitle();
        const oldRawName = await this.netmdInterface!._getDiscTitle();
        const hasGroups = oldRawName.indexOf('//') >= 0;
        const hasGroupsAndTitle = oldRawName.startsWith('0;');

        if (newName === oldName) {
            return;
        }

        let newNameWithGroups;

        if (hasGroups) {
            if (hasGroupsAndTitle) {
                newNameWithGroups = oldRawName.replace(/^0;.*?\/\//, newName !== '' ? `0;${newName}//` : ``); // Replace or delete the old title
            } else {
                newNameWithGroups = `0;${newName}//${oldRawName}`; // Add the new title
            }
        } else {
            newNameWithGroups = newName;
        }

        await this.netmdInterface!.cacheTOC();
        await this.netmdInterface!.setDiscTitle(newNameWithGroups);
        await this.netmdInterface!.syncTOC();
    }

    @asyncMutex
    async deleteTrack(index: number) {
        await this.netmdInterface!.eraseTrack(index);
        await sleep(100);
    }

    @asyncMutex
    async wipeDisc() {
        await this.netmdInterface!.eraseDisc();
    }

    @asyncMutex
    async moveTrack(src: number, dst: number) {
        await this.netmdInterface!.moveTrack(src, dst);
    }

    async upload(
        title: string,
        data: ArrayBuffer,
        format: Wireformat,
        progressCallback: (progress: { written: number; encrypted: number; total: number }) => void
    ) {
        let total = data.byteLength;
        let written = 0;
        let encrypted = 0;
        function updateProgress() {
            progressCallback({ written, encrypted, total });
        }

        let w = new Worker();

        let webWorkerAsyncPacketIterator = makeGetAsyncPacketIteratorOnWorkerThread(w, ({ encryptedBytes }) => {
            encrypted = encryptedBytes;
            updateProgress();
        });

        // Removing non ascii chars... Sorry, I didn't implement char encoding.
        title = sanitizeTitle(title);
        let mdTrack = new MDTrack(title, format, data, 0x80000, webWorkerAsyncPacketIterator);

        await download(this.netmdInterface!, mdTrack, ({ writtenBytes }) => {
            written = writtenBytes;
            updateProgress();
        });

        w.terminate();
    }

    @asyncMutex
    async play() {
        await this.netmdInterface!.play();
    }
    @asyncMutex
    async pause() {
        await this.netmdInterface!.pause();
    }
    @asyncMutex
    async stop() {
        await this.netmdInterface!.stop();
    }
    @asyncMutex
    async next() {
        await this.netmdInterface!.nextTrack();
    }
    @asyncMutex
    async prev() {
        await this.netmdInterface!.previousTrack();
    }

    @asyncMutex
    async gotoTrack(index: number) {
        await this.netmdInterface!.gotoTrack(index);
    }

    @asyncMutex
    async getPosition() {
        return await this.netmdInterface!.getPosition();
    }
}

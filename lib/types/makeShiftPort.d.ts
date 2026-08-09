/// <reference types="node" />
/// <reference types="node" />
import { PortInfo } from '@serialport/bindings-interface';
import { LogLevel, Msger } from '@eos-makeshift/msg';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
export declare enum PacketType {
    PING = 0,
    ACK = 1,
    READY = 2,
    STATE_UPDATE = 3,
    ERROR = 4,
    STRING = 5,
    DISCONNECT = 6,
    GAME_CARD_BEGIN = 7,
    GAME_ART_CHUNK = 8,
    GAME_CARD_COMMIT = 9,
    SCREEN_HOME = 10
}
export declare const MAX_PACKET_BODY_BYTES = 240;
export type LogMessage = {
    level: LogLevel;
    message: string;
    buffer: Buffer;
};
export type MakeShiftPortFingerprint = {
    devicePath: string;
    portId: string;
    deviceSerial: string;
};
export type MakeShiftPortOptions = {
    portInfo: PortInfo;
    logLevel: LogLevel;
    /**
     * this is automatically generated from nanoid if not given
     */
    id?: string;
    showTime?: boolean;
};
export declare const defaultMakeShiftPortOptions: {
    portInfo: PortInfo;
    logLevel: LogLevel;
    id: string;
    showTime: boolean;
};
export type MakeShiftState = {
    buttons: boolean[];
    dials: number[];
    dialsRelative: number[];
};
export declare class MakeShiftPort extends EventEmitter implements Msger {
    private serialPort;
    private slipEncoder;
    private slipDecoder;
    private _prevAckTime;
    private prevState;
    private _deviceReady;
    private _id;
    private _portInfo;
    private _msger;
    private keepAliveTimer;
    /**
     * This is a library global, it keeps track of the number of open ports
     */
    static get connectedDevices(): number;
    /**
     * This is the time that the last ack was received from the MakeShift device
     */
    get prevAckTime(): number;
    /**
     * Direct access to the isOpen property of the internal SerialPort instance
     */
    get isOpen(): boolean;
    /**
     * If device connected, returns the path as a string, else returns empty string
     */
    get devicePath(): string;
    get deviceSerial(): string;
    get fingerPrint(): MakeShiftPortFingerprint;
    get portInfo(): PortInfo | null;
    /**
     * 23 character id assigned to port on instantiation
     */
    get portId(): string;
    /**
     * Logging related properties
     */
    private log;
    private debug;
    private deviceEvent;
    private info;
    private warn;
    private error;
    private fatal;
    private get host();
    private _logLevel;
    get showTime(): boolean;
    set showTime(show: boolean);
    get logLevel(): LogLevel;
    set logLevel(l: LogLevel);
    get logTermFormat(): boolean;
    set logTermFormat(tf: boolean);
    private emitLog;
    constructor(options: MakeShiftPortOptions);
    private parseSlipPacketHeader;
    ping(): void;
    /**
     * Sends a typed binary packet through the port's existing SLIP encoder.
     * Keeping this on MakeShiftPort prevents clients from competing for the
     * underlying serial device.
     */
    sendPacket(type: PacketType, body?: Uint8Array): boolean;
    private handleStateUpdate;
    private sendByte;
    private send;
    static parseStateFromBuffer(data: Buffer): MakeShiftState;
    private open;
    close(): void;
    write: (line: string) => void;
}

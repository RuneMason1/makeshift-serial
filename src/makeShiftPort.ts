import { PortInfo } from '@serialport/bindings-interface'
import { SlipEncoder, SlipDecoder } from '@serialport/parser-slip-encoder'
import {
  Msg, strfy, nspct2, LogLevel, MsgLvFunctorMap, MsgOptions, Msger, LoggerFn, MsgLvStringMap
} from '@eos-makeshift/msg'

import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { SerialPort } from 'serialport'
import { filename } from 'pathe/utils'
import { nanoid } from 'nanoid'
import chalk from 'chalk'
import defu from 'defu'
import { SerialEvents, DeviceEvents } from './constants.js'

let _connectedDevices = 0;

export enum PacketType {
  PING,
  ACK,
  READY,
  STATE_UPDATE,
  ERROR,
  STRING,
  DISCONNECT,
  GAME_CARD_BEGIN,
  GAME_ART_CHUNK,
  GAME_CARD_COMMIT,
  SCREEN_HOME,
  GAME_LIST_BEGIN,
  GAME_LIST_ITEM,
  GAME_LIST_COMMIT,
  GOXLR_STATUS,
  NOW_PLAYING,
  ACTION_GLYPH,
  RUNTIME_MANIFEST_BEGIN,
  RUNTIME_COMPONENT,
  RUNTIME_MANIFEST_COMMIT,
  RUNTIME_CAPABILITIES,
  ASSET_BEGIN,
  ASSET_CHUNK,
  ASSET_COMMIT,
  DEVICE_VISUALS,
}

// Compatibility aliases while the public runtime/protocol surface migrates
// away from feature-specific naming. New code should prefer the generic names.
export const PacketAlias = {
  COLLECTION_CARD_BEGIN: PacketType.GAME_CARD_BEGIN,
  COLLECTION_ART_CHUNK: PacketType.GAME_ART_CHUNK,
  COLLECTION_CARD_COMMIT: PacketType.GAME_CARD_COMMIT,
  COLLECTION_LIST_BEGIN: PacketType.GAME_LIST_BEGIN,
  COLLECTION_LIST_ITEM: PacketType.GAME_LIST_ITEM,
  COLLECTION_LIST_COMMIT: PacketType.GAME_LIST_COMMIT,
  OVERLAY_GLYPH: PacketType.ACTION_GLYPH,
} as const

export const MAX_PACKET_BODY_BYTES = 240

export type LogMessage = {
  level: LogLevel,
  message: string,
  buffer: Buffer,
}

export type MakeShiftPortFingerprint = {
  devicePath: string,
  portId: string,
  deviceSerial: string,
}

export type MakeShiftPortOptions = {
  portInfo: PortInfo,
  logLevel: LogLevel,
  /**
   * this is automatically generated from nanoid if not given
   */
  id?: string,
  showTime?: boolean,
}

export const defaultMakeShiftPortOptions = {
  portInfo: {} as PortInfo,
  logLevel: 'all' as LogLevel,
  id: '',
  showTime: false,
}


export type MakeShiftState = {
  buttons: boolean[];
  dials: number[];
  dialsRelative: number[];
}


export class MakeShiftPort extends EventEmitter implements Msger {

  private serialPort: SerialPort
  private slipEncoder = new SlipEncoder(SLIP_OPTIONS)
  private slipDecoder = new SlipDecoder(SLIP_OPTIONS)
  private _prevAckTime: number = 0
  private prevState: MakeShiftState = {
    buttons: [
      false, false, false, false,
      false, false, false, false,
      false, false, false, false,
      false, false, false, false,
    ],
    dials: [0, 0, 0, 0],
    dialsRelative: [0, 0, 0, 0],
  }

  private _deviceReady = false
  private _id = ''
  private _portInfo: PortInfo | null = null
  private _msger: Msg

  private keepAliveTimer: NodeJS.Timer


  //---------- static get/setters

  /**
   * This is a library global, it keeps track of the number of open ports
   */
  static get connectedDevices(): number { return _connectedDevices }

  //---------- public get/setters

  /**
   * This is the time that the last ack was received from the MakeShift device
   */
  public get prevAckTime(): number { return this._prevAckTime }

  /**
   * Direct access to the isOpen property of the internal SerialPort instance
   */
  public get isOpen() {
    return (typeof this.serialPort !== 'undefined' && this.serialPort.isOpen)
  }

  /**
   * If device connected, returns the path as a string, else returns empty string 
   */
  public get devicePath(): string {
    if (this._portInfo !== null) {
      return this._portInfo.path
    } else {
      return ''
    }
  }

  public get deviceSerial(): string {
    return this._id
  }
  public get fingerPrint(): MakeShiftPortFingerprint {
    return {
      devicePath: this.devicePath,
      deviceSerial: this.deviceSerial,
      portId: this.portId,
    }
  }
  public get portInfo(): PortInfo | null {
    return this._portInfo
  }

  /**
   * 23 character id assigned to port on instantiation
   */
  public get portId(): string {
    if (this._portInfo !== null) {
      return this._portInfo.serialNumber
    } else {
      return ''
    }
    // if (this._portInfo !== null) {
    //   return this._portInfo.serialNumber
    // } else { return this._id }
  }

  /**
   * Logging related properties
   */
  private log: MsgLvFunctorMap
  private debug: Function
  private deviceEvent: Function
  private info: Function
  private warn: Function
  private error: Function
  private fatal: Function

  private get host(): string {
    let str = 'Port:' + chalk.green(filename(this.devicePath)) + '|'

    if (this._deviceReady) {
      str += chalk.magenta(this.deviceSerial.slice(0, 4))
    } else {
      str += chalk.yellow('D/C')
    }

    return str
  }

  private _logLevel: LogLevel = 'all'
  public get showTime(): boolean { return this._msger.showTime }
  public set showTime(show: boolean) { this._msger.showTime = show }
  public get logLevel(): LogLevel { return this._logLevel }
  public set logLevel(l: LogLevel) {
    this._logLevel = l
    this._msger.logLevel = l
  }
  public get logTermFormat() { return this._msger.terminal }
  public set logTermFormat(tf: boolean) { this._msger.terminal = tf }

  private emitLog: LoggerFn = (msg: string, lv: LogLevel) => {
    this.emit(SerialEvents.Log[lv], {
      // terminal: this._msger.terminal,
      level: lv,
      message: msg,
      buffer: Buffer.from(msg),
    } as LogMessage)
  }

  constructor(options: MakeShiftPortOptions) {
    super()

    const finalOpts = defu(options, defaultMakeShiftPortOptions);
    // console.log(finalOpts)
    this._portInfo = finalOpts.portInfo as PortInfo
    // set up logging
    this._msger = new Msg()
    this._msger.host = this.host
    this._msger.showTime = finalOpts.showTime
    this.log = this._msger.getLevelLoggers()

    // assign logLevel after _msger initialization
    this.logLevel = finalOpts.logLevel
    for (const lv in this.log) {
      this[lv] = (m: string) => {
        // this bit wraps the loggers from Msg with an emitter
        // so that all logging is also emitted as an event whether
        // or not it gets logged to console
        const logString = this.log[lv](m)
        this.emitLog(logString, lv as LogLevel)
      }
    }
    this.debug('Creating new MakeShiftPort with options: ' + nspct2(finalOpts))

    // The decoder is the endpoint which gets the 'raw' data from the makeshift
    // so all the work of parsing the raw data happens here
    this.slipDecoder.on('data', (d) => { this.parseSlipPacketHeader(d) }) // decoder -> console

    this.open()
  } // constructor()

  private parseSlipPacketHeader(data: Buffer) {
    this._prevAckTime = Date.now();
    const header: PacketType = data.subarray(0, 1).at(0)
    const body = data.subarray(1)
    this.debug(data)
    switch (header) {
      case PacketType.STATE_UPDATE: {
        let newState = MakeShiftPort.parseStateFromBuffer(body)
        this.emit(DeviceEvents.DEVICE.STATE_UPDATE, newState)
        this.debug('state updating')
        this.handleStateUpdate(newState)
        break
      }
      case PacketType.ACK: {
        // any other packet will also act as keepalive ACK, 
        // and is handled above
        this.debug(`Got ACK from MakeShift`)
        break
      }
      case PacketType.STRING: {
        this.debug(body.toString())
        this.emit(DeviceEvents.SERIAL.MESSAGE, body.toString())
        break
      }
      case PacketType.PING: {
        this.debug(`Got PING from MakeShift, responding with ACK`)
        this.sendByte(PacketType.ACK);
        break
      }
      case PacketType.ERROR: {
        this.debug(`Got ERROR from MakeShift`)
        break
      }
      case PacketType.READY: {
        this.debug(`Got READY from MakeShift`)
        this.debug(body.toString())
        _connectedDevices++
        this._deviceReady = true;
        this._id = body.toString().replaceAll('-', '')
        this._msger.host = this.host // reset the host to reflect new id
        this._prevAckTime = Date.now()
        this.deviceEvent(`Device connection established`)
        this.emit(DeviceEvents.DEVICE.CONNECTED, this.fingerPrint)
        break
      }
      default: {
        this.debug(header)
        this.debug(data.toString())
        break
      }
    }
  }

  ping() { this.sendByte(PacketType.PING) }

  /**
   * Sends a typed binary packet through the port's existing SLIP encoder.
   * Keeping this on MakeShiftPort prevents clients from competing for the
   * underlying serial device.
   */
  public sendPacket(type: PacketType, body: Uint8Array = new Uint8Array()): boolean {
    if (!this.isOpen || !this._deviceReady || body.byteLength > MAX_PACKET_BODY_BYTES) {
      return false
    }

    try {
      const packet = Buffer.allocUnsafe(body.byteLength + 1)
      packet[0] = type
      packet.set(body, 1)
      this.debug(`Sending packet: ${nspct2(packet)}`)
      this.slipEncoder.write(packet)
      return true
    } catch (error) {
      this.error(error)
      return false
    }
  }

  private handleStateUpdate(currState: MakeShiftState) {
    this.debug(`Handling state update`)
    for (let id = 0; id < NumOfButtons; id++) {
      if (currState.buttons[id] != this.prevState.buttons[id]) {
        let ev;
        if (currState.buttons[id] === true) {
          ev = DeviceEvents.BUTTON[id].PRESSED
        }
        else {
          ev = DeviceEvents.BUTTON[id].RELEASED
        }
        this.emit(ev, { state: currState, event: ev });
        this.deviceEvent(`${ev} with state ${currState.buttons[id]}`)
      }
    }
    let delta
    for (let id = 0; id < NumOfDials; id++) {
      delta = currState.dials[id] - this.prevState.dials[id]
      if (currState.dialsRelative[id] !== 0) {
        let ev;
        this.emit(DeviceEvents.DIAL[id].CHANGED, { state: currState, event: ev })
        if (currState.dialsRelative[id] > 0) {
          ev = DeviceEvents.DIAL[id].INCREMENT
        } else {
          ev = DeviceEvents.DIAL[id].DECREMENT
        }
        this.emit(ev, { state: currState, event: ev })
        this.deviceEvent(`${ev} with state ${currState.dials[id]}`)
      }
    }
    this.prevState = currState
  }


  private sendByte(t: PacketType): void {
    if (this.isOpen) {
      try {
        this.serialPort.flush()
        let buf = Buffer.from([t])
        this.debug(`Sending byte: ${nspct2(buf)}`)
        this.slipEncoder.write(buf)
      } catch (e) {
        this.error(e)
      }
    }
  }

  private send(t: PacketType, body: string): void {
    if (this.isOpen) {
      try {
        this.serialPort.flush()
        let h = Buffer.from([t])
        let b = Buffer.from(body)
        const buf = Buffer.concat([h, b]);
        this.debug(`Sending buffer: ${nspct2(buf)}`)
        // console.dir(buf)
        this.slipEncoder.write(buf)
      } catch (e) {
        this.error(e)
      }
    }
  }


  static parseStateFromBuffer(data: Buffer): MakeShiftState {
    let state: MakeShiftState = {
      buttons: [],
      dials: [],
      dialsRelative: []
    }

    const buttonsRaw = data.subarray(0, 2).reverse()
    const dialsRelativeRaw = data.subarray(2, 6)
    const dialsRaw = data.subarray(6)

    function bytesToBin(button: number, bitCounter: number) {
      if (bitCounter === 0) { return; }
      if (button % 2) {
        state.buttons.push(true)
      } else {
        state.buttons.push(false)
      }
      bytesToBin(Math.floor(button / 2), bitCounter - 1)
    }
    buttonsRaw.forEach((b) => bytesToBin(b, 8),)

    for (let i = 0; i < 4; i++) {
      state.dialsRelative.push(dialsRelativeRaw.readInt8(i))
    }
    state.dials.push(dialsRaw.readInt32BE(0))
    state.dials.push(dialsRaw.readInt32BE(4))
    state.dials.push(dialsRaw.readInt32BE(8))
    state.dials.push(dialsRaw.readInt32BE(12))

    return state
  }

  private async open() {
    this.serialPort = await new SerialPort({
      path: this.devicePath,
      baudRate: 42069
    }, (e) => {
      if (e != null) {
        this.error(`Something happened while opening port: `)
        this.error(e)
        this.emit(DeviceEvents.DEVICE.CONNECTION_ERROR, e)
      } else {
        this._msger.host = this.host
        this.info('SerialPort opened, attaching SLIP translators')
        this.slipEncoder.pipe(this.serialPort) // node -> teensy
        this.serialPort.pipe(this.slipDecoder) // teensy -> decoder
        this.info('Translators ready, sending READY to MakeShift')
        this.sendByte(PacketType.READY)
      }
    })
  }

  close() {
    this.info(`Closing MakeShift port...`)
    this.info(`Unpiping encoders`)
    this.slipEncoder.unpipe()
    this.serialPort.unpipe()
    if (this.isOpen) {
      this.info(`Port object found open`)
      this.info(`Sending disconnect packet`)
      this.sendByte(PacketType.DISCONNECT)
      this.info(`Closing port`)
      this.serialPort.close()
    }
    this._msger.host = this.host
    _connectedDevices--
    this._deviceReady = false;
    this.warn(`Port closed, sending disconnect signal`)
    this.emit(DeviceEvents.DEVICE.DISCONNECTED, this.fingerPrint)
  }

  write = (line: string): void => {
    if (this._deviceReady) {
      this.send(PacketType.STRING, line)
    } else {
      this.info("MakeShift not ready, line not sent")
    }
  }
}

//---------- Long constants




const NumOfButtons = DeviceEvents.BUTTON.length;

const NumOfDials = DeviceEvents.DIAL.length;

const SLIP_OPTIONS = {
  ESC: 219,
  END: 192,
  ESC_END: 220,
  ESC_ESC: 221,
}

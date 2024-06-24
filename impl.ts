import "./shim.js";

import { ccDest, Commands, ControlCommands } from "./datatypes.js";
import { XqBytesEnc, XqBytesDec } from "./func_replacements.js";
import { hexdump } from "./hexdump.js";
import { Session } from "./session.js";
import { u16_swap } from "./utils.js";
import { logger } from "./logger.js";

const str2byte = (s: string): number[] => {
  return Array.from(s).map((_, i) => s.charCodeAt(i));
};

{ // Dataview for packet
	DataView.prototype.note=function(note) {
		this._note=note;return this;
	};
	DataView.prototype._init = function(session) { // 0, 4, 5, 8
		const CHANNEL = 0;
		const START_CMD = 0x110a;
		this.setUint16(0,Commands.Drw);
		this.setUint8(4,0xd1);
		this.setUint8(5,CHANNEL);
		this.setUint16(8,START_CMD);
		this._data=[];
		this._seqs=[];
		this._session=session;
		return this;
	};
	DataView.prototype.dump = function() {
		let str=[ "\nPacket ID: ",this.seq(),'\n',
			(this._note?'Packet _note:'+this._note+'\n':''),
			hexdump(this), '\nPayload:',hexdump(this.getDV())
		];
		logger.info(str.join(''));
		return this;
	};
	DataView.prototype.getDV = function() {
		if(!this._data && !this._note) {
			if(this.len()>20) {
				let ud=new DataView(this.buffer,8,this.byteLength-8);
				XqBytesDec(ud,this.byteLength-8,4);
				return ud;
			}
			this._data=[];
		}
		let buflen=this._data.length;
		let new_buf = new Uint8Array(buflen);
		for(var i=0;i<buflen;i++) new_buf[i]=this._data[i];
		return new DataView(new_buf.buffer);
	}

	DataView.prototype.len = function(num) { // 2
		if(!arguments.length) return 4+this.getUint16(2);
		this.setUint16(2,num-4);
		return this;
	};
	DataView.prototype.stream = function(num) { // 5
		if(!arguments.length) return this.getUint8(5);
		this.setUint8(5,num);
		return this;
	};
	DataView.prototype.seq = function(num) { // 6
		if(!arguments.length) return this.getUint16(6);
		this.setUint16(6,num);
		this._seqs[num]=num;
		return this;
	};
	DataView.prototype.Ack = function(id) {
		let c=this._note;
		for(var num in this._seqs) {
			logger.debug(`Removing ${num}(${c}) from pending (Ack ${id})`);
			delete this._session.unackedDrw[num]
		}
		delete this._seqs;
	}
	DataView.prototype.cmdNum = function(num) { // 10, 14
		if(!arguments.length) return this.getUint16(10);
		this.setUint16(10,num);
		this.setUint16(14,ccDest[num]);
		return this;
	};
	DataView.prototype.paylen = function(num) { // 12
		if(!arguments.length) return this.getUint16(12,true);
		this.setUint16(12,num,true);
		return this;
	};
	DataView.prototype.ticket = function(arr) { // 16..19
		if(!arguments.length) return this.getBigUint64(16);
		this.setUint8(16,arr[0]);
		this.setUint8(17,arr[1]);
		this.setUint8(18,arr[2]);
		this.setUint8(19,arr[3]);
		return this;
	}
	DataView.prototype.setDataByte=function(i:number,val:number) { // 20+num
		const OFFSET=20, rotate=4, buflen=this._data.length;
		this._data[i]=val=parseInt(val);
		val += ((val & 1) ? -1 : 1);
		this.setUint8( OFFSET + i-rotate + (i<rotate ? buflen : 0) , val );
		return this;
	}
	DataView.prototype.setDataQ=function(n1:number,n2:number,n3:number) {
		this._data[0x13]=n1;
		this._data[0x17]=n2;
		this._data[0x1b]=n3;
		this.scramble();
		return this;
	}

	DataView.prototype.scramble = function() { // 20...
		const OFFSET=20, rotate=4;
		const data=this._data;
		const buflen=data.length;
		for (let i = 0; i < buflen; i++) {
			let v=parseInt(data[i]);
			v += ((v & 1) ? -1 : 1);
			this.setUint8( OFFSET + i-rotate + (i<rotate ? buflen : 0) , v );
		}
		return this;
	}
	DataView.prototype.unscramble = function() { // 20...
		const OFFSET=20, rotate=4;
		const buflen=this.byteLength-OFFSET;
		let data=[];
		for (let i = 0; i < buflen; i++) {
			let b:number = this.getUint8(i);
			b += ( b&1 ? -1 : 1 );
			i<rotate
			data[ i - rotate + (i<rotate?buflen:0) ]=b;
		}
		this._data=data;
		return this;
	}
	DataView.prototype.equals = function(dv) {
		if(this.byteLength!=dv.byteLength) return false;
		var l=this.byteLength;
		for(var i=0;i<l;i++) {
			if(this.getUint8(i) != dv.getUint8(i)) return false;
		}
		return true;
	}
	DataView.prototype.send = function() {
		let s=this._session;
		return s.send(this);
	}
}

// 'data' can be a DataView, Array, or number of bytes to allocate 
export function makeDrw (session: Session, command: number, data:DataView|number|Array): DataView {
  const DRW_HEADER_LEN = 0x10;
  const TOKEN_LEN = 0x4;

	let datalen=0;
	if(Number.isInteger(data)) datalen=data;
	else if(!data && command == ControlCommands.SubCmd) datalen=28;
	else if (data && data.byteLength) datalen=data.byteLength;

	let pkt_len = DRW_HEADER_LEN + TOKEN_LEN + datalen;
  const ret = new DataView(new Uint8Array(pkt_len).buffer);
	let cstr=makeDrw.caller.toString();
	if(cstr.length<20) ret._note=cstr;
	ret._init(session);
	ret.len( pkt_len );
	ret.paylen( TOKEN_LEN + datalen );
	
	if (!data && command == ControlCommands.SubCmd) {
		ret._data=[ 24,0,0,0,1,10,80,73,0,16,255,255,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0 ];
		ret.scramble();
	}
	else if(Number.isInteger(data)) {
		for(let i=0;i<data;i++) ret._data[i]=0;
		ret.scramble();
	}
  else if (data && datalen > 4) {
		for(let i=0;i<datalen;i++) ret._data[i]=data.getUint8(i);
		ret.scramble();
  }
	else if (data && datalen <= 4) {
		for(let i=0;i<datalen;i++) {
			ret._data[i]=data[i];
			ret.setUint8(20 + i, data[i]);
		}
	}

	ret.seq(session.outgoingCommandId++);
	if(command) ret.cmdNum(command);
	ret.ticket(session.ticket);
	
  return ret;
}
export const sendCommand = (session: Session, command: number, data: DataView | null): DataView  => {
  let buf=makeDataReadWrite(session, command, data);
	session.send(buf);
	// delete session.unackedDrw[session.outgoingCommandId-1];
	return buf;
};

export const makeCommand = {
	pan: (session: Session,n1:number=0,n2:number=0,n3:number=0) => makeDrw(session, ControlCommands.SubCmd).setDataQ(n1,n2,n3).note(`.pan(${n1}/${n2}/${n3})`),
	panToN: (session: Session, pos:number) => makeCommand.pan(session,1,1,pos).note(".panToN()"),
	toggleLight: (session: Session) => makeDrw(session, ControlCommands.LightToggle).note(".toggleLight()"),
	toggleIR: (session: Session) => makeDrw(session, ControlCommands.IRToggle).note(".toggleIR()"),
	setRes: (session: Session, q:number) => makeDrw(session, ControlCommands.VideoParamSet, 8).setDataByte(0,1).setDataByte(4,q).note(".setRes"),
	setQlty:(session: Session, q:number) => makeDrw(session, ControlCommands.VideoParamSet, 8).setDataByte(0,7).setDataByte(4,q).note(".setQlty"),
	startVideo: (session: Session) => makeDrw(session, ControlCommands.StartVideo).note(".startVideo()"),
	stopVideo: (session: Session) => makeDrw(session, ControlCommands.StopVideo).note(".stopVideo()"),
	reboot: (session: Session) => makeDrw(session, ControlCommands.Reboot).note(".reboot()"),
};

const makeDataReadWriteOrig = (session: Session, command: number, data: DataView | null): DataView => {
  const DRW_HEADER_LEN = 0x10;
  const TOKEN_LEN = 0x4;
  const CHANNEL = 0;
  const START_CMD = 0x110a;

  let pkt_len = DRW_HEADER_LEN + TOKEN_LEN;
  let payload_len = TOKEN_LEN;
  let bufCopy: Uint8Array | null = null;
  if (data && data.byteLength > 4) {
    bufCopy = new Uint8Array(data.buffer);
    const bufDV = new DataView(bufCopy.buffer);
    // this mutates the buffer, don't want to mutate the caller
    XqBytesEnc(bufDV, bufDV.byteLength, 4);
    pkt_len += bufDV.byteLength;
    payload_len += bufDV.byteLength;
  }

  const ret = new DataView(new Uint8Array(pkt_len).buffer);
  ret.setUint16(0,Commands.Drw);
  ret.setUint16(2,pkt_len - 4); // -4 as we ignore the [0xf1, 0xd0, len, len]
  ret.setUint8(4,0xd1); // ?
  ret.setUint8(5,CHANNEL);
  ret.setUint16(6,session.outgoingCommandId);
  ret.setUint16(8,START_CMD);
  ret.setUint16(10,command);
  ret.setUint16(12,u16_swap(payload_len));
  ret.setUint16(14,ccDest[command]);
  ret.writeBytesTo(16,session.ticket);
  if (data && data.byteLength > 4) {
    ret.writeBytesTo(20,bufCopy);
  }

  session.outgoingCommandId++;
  return ret;
};

const makeDataReadWriteChk = (session: Session, command: number, data: DataView | null): DataView => {
	let v2=makeDrw(session, command, data);
	let v1=makeDataReadWriteOrig(session, command, data);
	if(v1.equals(v2)) {
		logger.warning(`MakeDRW outputs okay for ${command}`);
	}else{
		logger.warning(`MakeDRW outputs not okay for ${command}`);
		logger.info("\nv1:\n"+hexdump(v1,{useAnsi:1, ansiColor:1}));
		logger.info("\nv2:\n"+hexdump(v2,{useAnsi:1, ansiColor:1}));
		logger.info("'nv2 data:\n"+hexdump(v2.getDV(),{useAnsi:1, ansiColor:1}));
	}
	return v2;
};

// const makeDataReadWrite = makeDataReadWriteChk;  // for testing
const makeDataReadWrite = makeDrw;

export const SendDevStatus = (session: Session): DataView => {
  return makeDataReadWrite(session, ControlCommands.DevStatus, null);
};

export const SendWifiSettings = (session: Session): DataView => {
  return makeDataReadWrite(session, ControlCommands.WifiSettings, null);
};

export const SendListWifi = (session: Session): DataView => {
  return makeDataReadWrite(session, ControlCommands.ListWifi, null);
};

export const getVideoKey = (session: Session): void => {
  // this is not useful at all
  for (let i = 0; i < 12; i++) {
    // payload len??
    const payload = [0x0, i]; //, 0x0, 0x0, 0x0, 0x0];
    const dv = new DataView(new Uint8Array(payload).buffer);
    session.send(makeDataReadWrite(session, ControlCommands.VideoParamGet, dv));
  }
};

export const SendVideoResolution = (session: Session, resol: 1 | 2 | 3 | 4): DataView[] => {
  // seems like 0x1 = resolution, and is specified by ID not by size
  // unclear what 0x2-0xf achieve - they report back as '0' always -- ignored?
  const pairs = {
    1: [
      // 320 x 240
      [0x1, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0],
      [0x7, 0x0, 0x0, 0x0, 0x20, 0x0, 0x0, 0x0],
    ],
    2: [
      // 640x480
      [0x1, 0x0, 0x0, 0x0, 0x2, 0x0, 0x0, 0x0],
      // [0x7, 0x0, 0x0, 0x0, 0x50, 0x0, 0x0, 0x0],
    ],
    3: [
      // also 640x480 on the X5 -- hwat now?
      [0x1, 0x0, 0x0, 0x0, 0x3, 0x0, 0x0, 0x0],
      [0x7, 0x0, 0x0, 0x0, 0x78, 0x0, 0x0, 0x0],
    ],
    4: [
      // also 640x480 on the X5 -- hwat now?
      [0x1, 0x0, 0x0, 0x0, 0x4, 0x0, 0x0, 0x0],
      [0x7, 0x0, 0x0, 0x0, 0xa0, 0x0, 0x0, 0x0],
    ],
    // maybe the 0x7 = bitrate??
  };

  return pairs[resol].map((payload: number[]) => {
    const dv = new DataView(new Uint8Array(payload).buffer);
    return makeDataReadWrite(session, ControlCommands.VideoParamSet, dv).note('SendVideoResolution');
  });
};

export const SendReboot = (session: Session): DataView => {
  let dv = null;
  return makeDataReadWrite(session, ControlCommands.Reboot, dv);
};

export const SendWifiDetails = (
  session: Session,
  ssid: string,
  password: string,
  channel: number,
  dhcp: boolean,
): DataView => {
  if (!dhcp) {
    throw new Error("only DHCP is supported");
  }
  let buf = new Uint8Array(0x108).fill(0);
  let cmd_payload = new DataView(buf.buffer);
  let mask_reversed = "0.255.255.255";
  // unclear which is which ))
  let m_ip = "0.0.0.0";
  let m_gw = "0.0.0.0";
  let m_dns1 = "0.0.0.0";
  let m_dns2 = "0.0.0.0";

  // tag_wifiParams in types/all.h
  cmd_payload.setUint8(0x0c,channel);
  cmd_payload.setUint8(0x10,0); // TODO: AUTH
  cmd_payload.setUint8(0x14,1); // DHCP
  cmd_payload.writeBytesTo(0x18,str2byte(ssid));
  cmd_payload.writeBytesTo(0x38,str2byte(password));
  cmd_payload.writeBytesTo(0xb8,str2byte(m_ip));
  cmd_payload.writeBytesTo(0xc8,str2byte(mask_reversed));
  cmd_payload.writeBytesTo(0xd8,str2byte(m_gw));
  cmd_payload.writeBytesTo(0xe8,str2byte(m_dns1));
  cmd_payload.writeBytesTo(0xf8,str2byte(m_dns2));

  const ret = makeDataReadWrite(session, ControlCommands.WifiSettingsSet, cmd_payload);
  return ret;
};

export const SendUsrChk = (session: Session, username: string, password: string): DataView => {
  let buf = new Uint8Array(0x20 + 0x80);
  buf.fill(0);
  let cmd_payload = new DataView(buf.buffer);
  // type is char account[0x20]; char password[0x80];
  cmd_payload.writeBytesTo(0,str2byte(username));
  cmd_payload.writeBytesTo(0x20,str2byte(password));
  return makeDataReadWrite(session, ControlCommands.ConnectUser, cmd_payload).note("SendUsrChk");
};

export const create_LanSearchExt = (): DataView => {
  const outbuf = new DataView(new Uint8Array(4).buffer);
  outbuf.setUint16(0,Commands.LanSearchExt);
  outbuf.setUint16(2,0x0);
  return outbuf;
};

export const create_LanSearch = (): DataView => {
  const outbuf = new DataView(new Uint8Array(4).buffer);
  outbuf.setUint16(0,Commands.LanSearch);
  outbuf.setUint16(2,0x0);
  return outbuf;
};

export const create_P2pRdy = (inbuf: DataView): DataView => {
  const P2PRDY_SIZE = 0x14;
  const outbuf = new DataView(new Uint8Array(P2PRDY_SIZE + 4).buffer);
  outbuf.setUint16(0,Commands.P2pRdy);
  outbuf.setUint16(2,P2PRDY_SIZE);
  outbuf.writeBytesTo(4,new Uint8Array(inbuf.readByteArray(P2PRDY_SIZE).buffer));
  return outbuf;
};

export const create_P2pAlive = (): DataView => {
  const outbuf = new DataView(new Uint8Array(4).buffer);
  outbuf.setUint16(0,Commands.P2PAlive);
  outbuf.setUint16(2,0);
  return outbuf;
};

export const create_P2pClose = (): DataView => {
  const outbuf = new DataView(new Uint8Array(4).buffer);
  outbuf.setUint16(0,Commands.Close);
  outbuf.setUint16(2,0);
  return outbuf;
};

export type DevSerial = { prefix: string; serial: string; suffix: string; serialU64: bigint; devId: string };
export const parse_PunchPkt = (dv: DataView): DevSerial => {
  const punchCmd = dv.getUint16(0);
  const len = dv.getUint16(2);
  const prefix = dv.readStringFrom(4,4);
  const serialU64 = dv.getBigUint64(8);
  const serial = serialU64.toString();
  const suffix = dv.readStringFrom(16,len - 16 + 4); // 16 = offset, +4 header
  const devId = prefix + serial + suffix;

  return { prefix, serial, suffix, serialU64, devId };
};


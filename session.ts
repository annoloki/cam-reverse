import { createSocket, RemoteInfo } from "node:dgram";
import { config } from "./settings.js";
import fs from "node:fs";
import EventEmitter from "node:events";

import { Commands, CommandsByValue, ControlCommandsByValue } from "./datatypes.js";
import {
  handle_Close,
  handle_Drw,
  handle_DrwAck,
  handle_P2PAlive,
  handle_P2PRdy,
  makeP2pRdy,
  notImpl,
  noop,
} from "./handlers.js";
import { create_P2pAlive, DevSerial, makeCommand, SendVideoResolution, SendWifiDetails } from "./impl.js";
import { logger } from "./logger.js";

export type Session = {
  send: (msg: DataView) => void;
  ackDrw: (id: number) => void;
  unackedDrw: { [id: number]: { sent_ts: number; data: DataView } };
  needAck: {};
  outgoingCommandId: number;
  ticket: number[];
  eventEmitter: EventEmitter;
  dst_ip: string;
  lastReceivedPacket: number;
  connected: boolean;
  devName: string;
  timers: ReturnType<typeof setInterval>[];
  curImage: Buffer[];
  rcvSeqId: number;
  frame_is_bad: boolean;
  frame_was_fixed: boolean;
  started: boolean;
  close: () => void;
  packets: {};
};

export type PacketHandler = (session: Session, dv: DataView, rinfo: RemoteInfo) => void;

type msgCb = (
  session: Session,
  handlers: Record<keyof typeof Commands, PacketHandler>,
  msg: Buffer,
  rinfo: RemoteInfo,
) => void;

const handleIncoming: msgCb = (session, handlers, msg, rinfo) => {
  const ab = new Uint8Array(msg).buffer;
  const dv = new DataView(ab);
  const raw = dv.getUint16(0);
  session.recPacket(dv);
  const cmd = CommandsByValue[raw];
  // session.lastReceivedPacket = Date.now();
  logger.log("trace", `<< ${cmd}`);
  handlers[cmd](session, dv, rinfo);
  if (raw != Commands.P2PAlive && raw != Commands.P2PAliveAck) {
    session.lastReceivedPacket = Date.now();
  }
};

export const makeSession = (
  handlers: Record<keyof typeof Commands, PacketHandler>,
  dev: DevSerial,
  ra: RemoteInfo,
  onLogin: (s: Session) => void,
  timeoutMs: number,
): Session => {
  let counter = {recvBytes:0, recvData:0, recvPkts:0, sentBytes:0, sentPkts:0, lostPkts:0, dropPkts:0,dropBytes:0 };
  const sock = createSocket("udp4");

  sock.on("error", (err) => {
    console.error(`sock error:\n${err.stack}`);
    sock.close();
  });

  sock.on("message", (msg, rinfo) => {
    counter.recvPkts++;
    counter.recvBytes+=msg.byteLength;
    handleIncoming(session, handlers, msg, rinfo)
  });

  sock.on("listening", () => {
    const buf = makeP2pRdy(dev);
    session.send(buf);
    session.started = true;
  });

  sock.bind();
  const sessTimer = setInterval(() => {
    const delta = Date.now() - session.lastReceivedPacket;
    if (session.started) {
      if (delta > 600) {
        let buf = create_P2pAlive();
        session.send(buf);
      }
      if (delta > timeoutMs) {
        logger.warning(`Camera ${session.devName} timed out (${delta})`);
        session.eventEmitter.emit("disconnect");
      }
    }
  }, 400);

  const resendTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of Object.entries(session.unackedDrw)) {
      const { sent_ts, data } = value;
      if (sent_ts>0 && now - sent_ts > 200) {
        const pkt_id = data.seq();
        let new_id=pkt_id;
        value.sent_ts=0;
        if(session.outgoingCommandId > pkt_id + 1) {
          new_id=session.outgoingCommandId++;
          data.seq(new_id);
        }
        logger.debug(`Resending packet ${pkt_id} as ${new_id}`);
        session.send(data);
      }
    }
  }, 500);

  const session: Session = {
    outgoingCommandId: 0,
    ticket: [ 0, 0, 0, 0 ],
    lastReceivedPacket: 0,
    eventEmitter: new EventEmitter(),
    connected: true,
    timers: [sessTimer, resendTimer],
    devName: dev.devId,
    started: false,
    send: (msg: DataView) => {
      if(msg._note) session._lastnote=msg._note;
      let unackedDrw=session.unackedDrw;
      const raw = msg.getUint16(0);
      const cmd = CommandsByValue[raw];
      // send command
      if (raw == 0xf1d0 && msg.getUint8(4) == 0xd1) {
        const packet_id = msg.seq();
        logger.debug(`Sending Drw Packet with id ${packet_id}`);
        unackedDrw[packet_id] = { sent_ts: Date.now(), data: msg };
      }
      logger.log("trace", `>> ${cmd}`);
      sock.send(new Uint8Array(msg.buffer), ra.port, session.dst_ip);
      counter.sentPkts++;
      counter.sentBytes+=msg.byteLength;
    },
    ackDrw: (id: number) => {
      let unackedDrw=session.unackedDrw;
      if(unackedDrw[id]) unackedDrw[id].data.Ack(id);
    },
    dst_ip: ra.address,
    curImage: [],
    rcvSeqId: 0,
    frame_is_bad: false,
    frame_was_fixed: false,
    unackedDrw: {},
    needAck: {},
    dataAck: (id) => {
      session.needAck[id]=id;
    },
    sendAcks: () => {
      let needAck=Object.keys(session.needAck);
      let nl=needAck.length;
      if(!nl) return;
      let len = nl * 2 + 4;
      let outbuf = new DataView(new Uint8Array(len+4).buffer);
      outbuf.setUint16(0,Commands.DrwAck);
      outbuf.setUint16(2,len);
      outbuf.setUint8(4,0xd2);
      outbuf.setUint8(5,1); // data
      outbuf.setUint16(6,nl);
      let i=8, al=[];
      for(k in needAck) {
        let v=needAck[k];
        outbuf.setUint16(i,v);
        i+=2;
        delete session.needAck[v];
      }
      // logger.debug(`Acking ${nl} IDs `);
      session.send(outbuf);
    },
    close: () => {
      session.eventEmitter.emit("disconnect");
    },
  };

  session.timers.push( setInterval( session.sendAcks ,100) );

  session.eventEmitter.on("disconnect", () => {
    logger.info(`Disconnected from camera ${session.devName} at ${session.dst_ip}`);
    session.dst_ip = "0.0.0.0";
    session.connected = false;
    session.timers.forEach((x) => clearInterval(x));
    session.timers = [];
    session.needAck = [];
    session.unackedDrw = {};
    sock.close();
  });

  session.eventEmitter.on("login", () => {
    logger.info(`Logging in to camera ${session.devName}`);
    onLogin(session);
  });

  var segs={}, _nextsend=0, _hipkt=0;
  var lostframe={}, waitloss=64, waiting=0;
  session.addFrame=(pkt_id,buf) => {
    counter.recvData+=buf.byteLength;
    if(pkt_id>_hipkt) _hipkt=pkt_id;
    if(pkt_id<_nextsend) return;
    if(!_nextsend) _nextsend=pkt_id;
    if(pkt_id==_nextsend) {
      _nextsend++
      session.sendSeg(buf,buf.startframe,segs[_nextsend]?1:0);
      if(segs[_nextsend]) logger.debug(`Recovering out-of-order frame ${_nextsend}`);
    }else{
      segs[pkt_id]=buf;
      if(_hipkt > (_nextsend+waitloss)) {
        while(!segs[_nextsend]?.startframe && _nextsend<_hipkt) {
          if(segs[_nextsend]) {
            logger.debug(`deleteframe->:${_nextsend}`);
            counter.dropPkts++;
            counter.dropBytes+=segs[_nextsend].byteLength;
            delete segs[_nextsend];
          }else{
            logger.debug(`lostframe->ns:${_nextsend}`);
            counter.lostPkts++;
          }
          _nextsend++;
        }
      }
    }
    while(segs[_nextsend]) {
      session.sendSeg(segs[_nextsend],segs[_nextsend].startframe,segs[_nextsend+1]?1:0);
      delete segs[_nextsend];
      _nextsend++;
    }
  };
  // Record selected packets for web viewing
  session.packets={stats: {
    counter:session.counter=counter
  }};
  session._lastnote='';
  session.recPacket=(buf: DataView) => {
    if(buf._note) {
      session._lastnote=buf._note;return;
    }
    let cmd1=Number(buf.getUint16(0));
    let cmd1h='0x'+cmd1.toString(16);
    let c1n=CommandsByValue[cmd1];
    let buflen=buf.byteLength;
    let len=buf.len();
    let s=buf.getUint8(5);
    let pkt={ buflen:len, cmd1: cmd1h, cmd1name:c1n, stream:s  };
    if(buf._c1n) c1n=buf._c1n;
    if(buf._recpkt) pkt=buf._recpkt; else buf._recpkt=pkt;
    if(buf._recnode) pkt.recnote=buf._recnote;
    let ad2=1;
    if(len>12 && (cmd1!=0xf1d0 || s!=1)) {
      let cmd2=Number(buf.getUint16(10));
      let cmd2h='0x'+cmd2.toString(16);
      if(cmd2) {
        pkt.cmd2=cmd2h;
        ad2=ControlCommandsByValue[cmd2];
        if(ad2) pkt.cmd2name=ad2; else ad2=cmd2h;
      }
    }
    if(session._lastnote) pkt.lastsentnote=session._lastnote;
    if(s!=1) {
      let data=[];
      for(var i=0;i<len;i++) {
        data.push('0x'+Number(buf.getUint8(i)).toString(16));
      }
      if(buf._unscrambled) pkt.unscrambled='yes';
      else if(len>24) {
        if(!buf._data) buf.unscramble();
        pkt._data=buf._data;
      }
      pkt.data=data;
    }
    if(!c1n) c1n=cmd1h;
    if(!session.packets[c1n]) session.packets[c1n]={};
    session.packets[c1n][ad2]=pkt;
     return pkt;
   }
  session.getPackets=() => {
    var str;
    const page = fs.readFileSync("getpackets.js", { encoding: "utf-8" });
    eval(page);
    return str;
  }
  return session;
};

export const configureWifi = (ssid: string, password: string, channel: number) => {
  return (s: Session) => {
    [SendWifiDetails(s, ssid, password, channel, true)].forEach(s.send);
  };
};

export const startVideoStream = (s: Session) => {
  makeCommand.startVideo(s).send();
  // [
    // ...SendVideoResolution(s, 2), // 640x480
  // ].forEach(s.send);
};

export const Handlers: Record<keyof typeof Commands, PacketHandler> = {
  PunchPkt: notImpl,
  P2PAlive: handle_P2PAlive,
  P2pRdy: handle_P2PRdy,
  DrwAck: handle_DrwAck,
  Drw: handle_Drw,
  Close: handle_Close,

  P2PAliveAck: noop,
  LanSearchExt: notImpl,
  LanSearch: notImpl,
  Hello: notImpl,
  P2pReq: notImpl,
  LstReq: notImpl,
  PunchTo: notImpl,
  HelloAck: notImpl,
  RlyTo: notImpl,
  DevLgnAck: notImpl,
  P2PReqAck: notImpl,
  ListenReqAck: notImpl,
  RlyHelloAck: notImpl, // always
  RlyHelloAck2: notImpl, // if len >1??
};

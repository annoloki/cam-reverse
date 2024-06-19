import { createSocket, RemoteInfo } from "node:dgram";
import { config } from "./settings.js";
import EventEmitter from "node:events";

import { Commands, CommandsByValue } from "./datatypes.js";
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
  const sock = createSocket("udp4");

  sock.on("error", (err) => {
    console.error(`sock error:\n${err.stack}`);
    sock.close();
  });

  sock.on("message", (msg, rinfo) => handleIncoming(session, handlers, msg, rinfo));

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
			// if(timeoutMs < 7000) timeoutMs=7000;
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
    },
    ackDrw: (id: number) => {
			let unackedDrw=session.unackedDrw;
      if(unackedDrw[id]) unackedDrw[id].data.Ack(id);
    },
    dst_ip: ra.address,
    curImage: [],
		startFrame:0,
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

	const ackTimer = setInterval( session.sendAcks ,100);

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

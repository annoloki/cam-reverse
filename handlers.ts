import { Commands, CommandsByValue, ControlCommands } from "./datatypes.js";
import { XqBytesDec } from "./func_replacements.js";
import { create_P2pRdy, DevSerial, SendListWifi, SendUsrChk } from "./impl.js";
import { logger } from "./logger.js";
import { Session } from "./session.js";
import { config } from "./settings.js";

export const notImpl = (session: Session, dv: DataView) => {
  const raw = dv.getUint16(0);
  const cmd = CommandsByValue[raw];
  logger.debug(`^^ ${cmd} (${raw.toString(16)}) and it's not implemented yet`);
};

export const noop = (_: Session, __: DataView) => {};
const create_P2pAliveAck = (): DataView => {
  const outbuf = new DataView(new Uint8Array(4).buffer);
  outbuf.setUint16(0,Commands.P2PAliveAck);
  outbuf.setUint16(2,0);
  return outbuf;
};

export const handle_P2PAlive = (session: Session, _: DataView) => {
  const b = create_P2pAliveAck();
  session.send(b);
};

export const handle_P2PRdy = (session: Session, _: DataView) => {
  // TODO - config
  const b = SendUsrChk(session, "admin", "admin");
  session.send(b);
};

export const makeP2pRdy = (dev: DevSerial): DataView => {
  const outbuf = new DataView(new Uint8Array(0x14).buffer); // 8 = serial u64
  // The protocol seems to expect 4 bytes -- check the regression test
  // `replies properly to PunchPkt with 3-letters-long prefix` for a case with a
  // real device
  const devPrefixLength = 4;
  outbuf.writeStringTo(0,dev.prefix);
  outbuf.setBigUint64(4,dev.serialU64);
  outbuf.writeStringTo(8 + devPrefixLength,dev.suffix);
  return create_P2pRdy(outbuf);
};

const swVerToString = (swver: number): string => {
  return (
    ((swver >> 24) & 255).toString() +
    "." +
    ((swver >> 16) & 255).toString() +
    "." +
    ((swver >> 8) & 255).toString() +
    "." +
    (swver & 255).toString()
  );
};
export const createResponseForControlCommand = (session: Session, dv: DataView): DataView[] => {
  const start_type = dv.getUint16(8); // 0xa11 on control; data starts here on DATA pkt
  const cmd_id = dv.getUint16(10); // 0x1120
  session.recPacket(dv);
  let payload_len = dv.getUint16(0xc,1);
  if (dv.byteLength > 20 && payload_len > dv.byteLength) {
    logger.warning(`Received a cropped payload: ${payload_len} when packet is ${dv.byteLength}`);
    payload_len = dv.byteLength - 20;
  }

  if (start_type != 0x110a) {
    logger.error(`Expected start_type to be 0xa11, got 0x${start_type.toString(16)}`);
    dv.dump();
    return [];
  }
  const rotate_chr = 4;
  if (payload_len > rotate_chr) {
    // 20 = 16 (header) + 4 (??)
    XqBytesDec(dv.add(20), payload_len - 4, rotate_chr);
    dv._unscrambled=1;
  }

  // the first 20 bytes are header

  switch (cmd_id) {
    case ControlCommands.ConnectUserAck:
      let c = new Uint8Array(dv.readBytesFrom(0x18,4).buffer);
      session.ticket = [...c];
      session.eventEmitter.emit("login");
      return [];

    case ControlCommands.DevStatusAck:
      // ParseDevStatus -> offset relevant?
      const charging = dv.getUint32(0x28,1) & 1 ? "" : "not "; // 0x14000101 v 0x14000100
      const power = dv.getUint16(0x18,1); // '3730' or '3765', milliVolts
      const dbm = dv.getUint8(0x24) - 0x100; // 0xbf - 0x100 = -65dbm .. constant??
      const n_swver = dv.getUint32(0x14,1);
      const swver = swVerToString(n_swver);

      // > -50 = excellent, -50 to -60 good, -60 to -70 fair, <-70 weak

      logger.info(
        `Camera ${session.devName}: sw: ${swver}, ${charging}charging, battery at ${power / 1000}V, Wifi ${dbm} dBm`,
      );
      return [];

    case ControlCommands.WifiSettingsAck:
      const wifiSettings = {
        enable: dv.getUint32(0x14),
        status: dv.getUint32(0x18),
        mode: dv.getUint32(0x1c,1),
        channel: dv.getUint32(0x20),
        authtype: dv.getUint32(0x24),
        dhcp: dv.getUint32(0x28),
        ssid: dv.readStringFrom(0x2c,0x20),
        psk: dv.readStringFrom(0x4c,0x80),
        ip: dv.readStringFrom(0xcc,0x10),
        mask: dv.readStringFrom(0xdc,0x10),
        gw: dv.readStringFrom(0xec,0x10),
        dns1: dv.readStringFrom(0xfc,0x10),
        dns2: dv.readStringFrom(0x10c,0x10),
      };
      const buf = SendListWifi(session);
      logger.info(`Current Wifi settings: ${JSON.stringify(wifiSettings, null, 2)}`);
      return [buf];

    case ControlCommands.ListWifiAck:
      if (payload_len == 4) {
        logger.debug("ListWifi returned []");
        return [];
      }
      const items = parseListWifi(dv);
      session.eventEmitter.emit("ListWifi", items);
      return [];
    case ControlCommands.StartVideoAck:
      logger.debug("Start video ack");
      return [];
    case ControlCommands.StopVideoAck:
      logger.debug("Stop video ack");
      return [];
    case ControlCommands.VideoParamSetAck:
      logger.debug("Video param set ack");
      return [];
    case 0xff50:
      logger.debug("SubCmdAck ack");
      return [];
    default:
      logger.info(`Unhandled control command: 0x${cmd_id.toString(16)}`);
      dv.dump();
  }
  return [];
};

export type WifiListItem = {
  ssid: string;
  mac: string;
  security: number;
  dbm0: number;
  dbm1: number;
  mode: number;
  channel: number;
};

export const parseListWifi = (dv: DataView): WifiListItem[] => {
  let startat = 0x10;
  const msg_len = 0x5c; // 0x58 + 0x4 of the last u32
  const msg_count = dv.getUint32(startat,1);
  startat += 4;
  let items = [];
  for (let i = 0; i < msg_count; i++) {
    if (startat + msg_len > dv.byteLength) {
      logger.warning("Wifi listing got cropped");
      break;
    }
    const macBytes = dv.readBytesFrom(startat + 0x40,6).buffer;
    const mb = new Uint8Array(macBytes);
    const wifiListItem = {
      ssid: dv.readStringFrom(startat,0x40),
      mac: [...mb].map((b) => b.toString(16).padStart(2, "0")).join(":"),
      security: dv.getUint32(startat + 0x48,1),
      dbm0: dv.getUint32(startat + 0x4c,1),
      dbm1: dv.getUint32(startat + 0x50,1),
      mode: dv.getUint32(startat + 0x54,1),
      channel: dv.getUint32(startat + 0x58,1),
    };
    startat += msg_len;
    items.push(wifiListItem);
  }
  return items;
};

const deal_with_data = (session: Session, dv: DataView) => {
  const pkt_len = dv.getUint16(2)-4;

  // 12 equals start of header (0x8) + header length (0x4)
  if (pkt_len < 8) {
    let alen=dv.byteLength;
    logger.log("trace", "Got a short Drw packet, ignoring");
    logger.debug(`Got a short Drw packet, ignoring (pkt_len:${pkt_len}, actual len:${alen})`);
    dv._recnote='short packet';
    dv._c1n='shortDrw';
    session.recPacket(dv);
    return true;
  }

  const FRAME_HEADER = [0x55, 0xaa, 0x15, 0xa8];
  const JPEG_HEADER =  [0xff, 0xd8, 0xff, 0xdb];
  const m_hdr = dv.readBytesFrom(8,4);
  const pkt_id = dv.getUint16(6);
  const STREAM_TYPE_AUDIO = 0x06;
  const STREAM_TYPE_JPEG = 0x03;
  const fix_packet_loss = config.cameras[session.devName].fix_packet_loss;

  let startNewFrame, addToFrame;
  if(fix_packet_loss < 2) {
    startNewFrame = (buf: ArrayBuffer) => {
      session.counter.recvData+=buf.byteLength;
      if (session.curImage.length > 0 && !session.frame_is_bad) session.eventEmitter.emit("frame");
      session.frame_was_fixed = false;
      session.frame_is_bad = false;
      session.curImage = [Buffer.from(buf)];
      session.rcvSeqId = pkt_id;
    };
  }
  else if(fix_packet_loss == 2) {
    startNewFrame = (buf: ArrayBuffer|Buffer|string) => {
      if(buf instanceof ArrayBuffer) buf=Buffer.from(buf);
      buf.startframe=1;
      session.addFrame(pkt_id,buf,1);
    };
    addToFrame = (buf: ArrayBuffer|Buffer|string) => {
      if(buf instanceof ArrayBuffer) buf=Buffer.from(buf);
      buf.startframe=0;
      session.addFrame(pkt_id,buf,0);
    };
  }

  let is_framed = m_hdr.startsWith(FRAME_HEADER);
  let is_new_image = m_hdr.startsWith(JPEG_HEADER);

  if (is_framed) {
    const stream_type = dv.getUint8(12);
    if (stream_type == STREAM_TYPE_AUDIO) {
      const audio_len = dv.getUint16(8 + 16,1);
      const audio_buf = dv.readBytesFrom(40, audio_len).buffer; // 8 for pkt header, 32 for `stream_head_t`
      session.eventEmitter.emit("audio", { gap: false, data: Buffer.from(audio_buf) });
    }
    else if (stream_type == STREAM_TYPE_JPEG) {
      const to_read = pkt_len - 32;
      if (to_read > 0) {
        // some cameras do not send the data with the frame, but rather as a
        // followup message skip 8 bytes (drw header) + 32 bytes (data frame)
        const data = dv.readBytesFrom(32+8,to_read);
        startNewFrame(data.buffer);
      }
    }
    else {
      logger.debug(`Ignoring data frame with stream type ${stream_type} - not implemented`);
      // not sure what these are for, there's one per frame. maybe alignment?
    }
  }
  else {
    // a new JPEG image may begin either
    // - as a frame with stream_type == 0x03
    // - as unframed data, started by JPEG_HEADER
    // but for both types of cameras, unframed data which does not start with
    // JPEG_HEADER are segments of the (potentially already started) JPEG image
    const data = dv.readBytesFrom(8,pkt_len);
    // this only happens on un-framed-cameras, which start the JPEG image
    // directly
    if (is_new_image) {
      startNewFrame(data.buffer);
    }
    else {
      if (pkt_id <= session.rcvSeqId) {
        // retransmit
        return true;
      }
      if(addToFrame) return addToFrame(data.buffer);

      let b = Buffer.from(data.buffer);

      if (pkt_id > session.rcvSeqId + 1) {
        if (!session.frame_is_bad) {
          session.frame_is_bad = true;
          if (!config.cameras[session.devName].fix_packet_loss) {
            logger.debug(`Dropping corrupt frame ${pkt_id}, expected ${session.rcvSeqId + 1}`);
          }
        }
        // this should always be enabled but currently it seems to cause more
        // visual distortion than just missing some frames
        if (!fix_packet_loss) {
          return true;
        }

        if (session.curImage.length = 1) return false; // header does not have markers

        let lastFrameSlice = session.curImage[session.curImage.length - 1];
        let lastResetMarker;
        lastResetMarker = findAllResetMarkers(lastFrameSlice).pop();
        if (lastResetMarker == undefined) {
          // not storing rcvSeqId as this frame did not put us back in track
          return false;
        }

        const firstResetMarker = findAllResetMarkers(b).shift();
        if (firstResetMarker == undefined) {
          // not storing rcvSeqId as this frame did not put us back in track
          return false;
        }

        session.curImage[session.curImage.length - 1] = Buffer.from(lastFrameSlice.subarray(0, lastResetMarker));
        b = Buffer.from(b.subarray(firstResetMarker));
        session.frame_is_bad = false;
        session.frame_was_fixed = true;
      }

      session.rcvSeqId = pkt_id;
      if (session.curImage != null) {
        session.curImage.push(b);
        if(fix_packet_loss < 2 || retry==0) session.counter.recvData+=b.byteLength;
      }
    }
  }
};

const findAllResetMarkers = (b: Buffer): number[] => {
  // a reset marker is a byte 0xff followed by a byte 0xd0-0xd7
  let ret = [];
  for (let i = 0; i < b.length - 1; i++) {
    if (b[i] == 0xff) {
      const nb = b[i + 1];
      if (nb >= 0xd0 && nb <= 0xd7) {
        ret.push(i);
      }
    }
  }
  return ret;
};

// For single acks. Use session->dataAck(pkt_id) for
// coalescing acks
const makeDrwAck = (dv: DataView): DataView => {
  const pkt_id = dv.seq();
  const m_stream = dv.stream(); // data = 1, control = 0
  const item_count = 1;
  const reply_len = item_count * 2 + 4; // 4 hdr, 2b per item
  const outbuf = new DataView(new Uint8Array(10).buffer);
  outbuf.setUint16(0,Commands.DrwAck);
  outbuf.setUint16(2,reply_len);
  outbuf.setUint8(4,0xd2);
  outbuf.setUint8(5,m_stream);
  outbuf.setUint16(6,item_count);
  outbuf.setUint16(8,pkt_id);
  return outbuf;
};

export const handle_DrwAck = (session: Session, dv: DataView) => {
  const packetlen = dv.getUint16(2);
  const str_type = dv.getUint8(4);
  const str_id = dv.getUint8(5);
  const ack_count = dv.getUint16(6);
  for (let i = 0; i < ack_count; i++) {
    const ack_id = dv.getUint16(8 + i * 2);
    session.ackDrw(ack_id);
  }
};
export const handle_Drw = (session: Session, dv: DataView) => {
  const m_stream = dv.getUint8(5); // data = 1, control = 0
  if (m_stream == 1) {
    session.dataAck(dv.seq()); // Add pkt_id to list to ack
    deal_with_data(session, dv);
  } else if (m_stream == 0) {
    session.send(makeDrwAck(dv));
    const b = createResponseForControlCommand(session, dv);
    b.forEach(session.send);
  } else {
    logger.warning(`Received a Drw packet with stream tag: ${m_stream}, which is not implemented`);
  }
};
export const handle_Close = (session: Session, dv: DataView) => {
  const ack = makeDrwAck(dv);
  session.send(ack);
  logger.info("Requested to close connection");
  session.close();
};

import { RemoteInfo } from "dgram";
import http from "node:http";
import fs from "node:fs";

import { logger } from "./logger.js";
import { config } from "./settings.js";
import { discoverDevices } from "./discovery.js";
import { DevSerial, makeCommand, makeDrw } from "./impl.js";
import { Handlers, makeSession, Session, startVideoStream } from "./session.js";
import { addExifToJpeg, createExifOrientation } from "./exif.js";

// @ts-expect-error TS2307
import favicon from "./cam.ico.gz";
// @ts-expect-error TS2307
// import html_template from "./asd.html";

const BOUNDARY = "a very good boundary line";
const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);
const responses: Record<string, http.ServerResponse[]> = {};
const audioResponses: Record<string, http.ServerResponse[]> = {};
const sessions: Record<string, Session> = {};

// https://sirv.com/help/articles/rotate-photos-to-be-upright/
const oMap = [1, 8, 3, 6];
const oMapMirror = [2, 7, 4, 5];
const orientations = [1, 2, 3, 4, 5, 6, 7, 8].reduce((acc, cur) => {
  return { [cur]: createExifOrientation(cur), ...acc };
}, {});

// Reads the mapping of serial numbers to camera names from the text file.

// Returns the camera name (custom name, if it exists, otherwise its ID).
const cameraName = (id: string): string => config.cameras[id].alias || id;

// The HTTP server.
export const serveHttp = (port: number) => {

  let _rx;
  const procpage=(res, page, devId):void=>{
    let s,t,vars={
      id:devId, name:cameraName(devId),
      exif:config.cameras[devId].exif ? 1 : 0,
      rotate:config.cameras[devId].rotate,
      mirror:config.cameras[devId].mirror,
      audio:config.cameras[devId].audio ? "true" : "false"
    };
    if(!_rx) _rx=new RegExp("\\${("+Object.keys(vars).join('|')+")}",'g');
    res.end( page.replace(_rx, (s,t)=>vars[s,t]) );
  };
  const server = http.createServer((req, res) => {

    let urlbits=req.url.split("/");
    if (urlbits[1] == "favicon.ico") {
      res.setHeader("Content-Type", "image/x-icon");
      res.setHeader("Content-Encoding", "gzip");
      res.end(Buffer.from(favicon));
      return;
    }
    if(!urlbits[1]) {
      res.write("<html>");
      res.write("<head>");
      res.write(`<link rel="shortcut icon" href="/favicon.ico">`);
      res.write("<title>All cameras</title>");
      res.write("</head>");
      res.write("<body>");
      res.write("<h1>All cameras</h1><hr/>");
      Object.keys(sessions).forEach((id) =>
        res.write(`<h2>${cameraName(id)}</h2><a href="/${id}/ui"><img src="/${id}/camera"/></a><hr/>`),
      );
      res.write("</body>");
      res.write("</html>");
      res.end();
      return;
    }

    let [x,devId, cmd, n1, n2, n3]=urlbits;
    let s,conf,resp;
    if(devId) {
      s= sessions[devId] ? sessions[devId] : undefined;
      conf=config.cameras[devId] ? config.cameras[devId] : {};
      resp=responses[devId];
    }

    if(s) {
      if(cmd=='audio') {
        if (s === undefined) {
          res.writeHead(400);
          res.end("invalid ID");
          return;
        }
        if (!s.connected) {
          res.writeHead(400);
          res.end("Nothing online");
          return;
        }
        res.setHeader("Content-Type", `text/event-stream`);
        audioResponses[devId].push(res);
        logger.info(`Audio stream requested for camera ${devId}`);
        return;
      }
      else if(cmd=="ir") {
        logger.info(`ToggleIR on ${devId}`);
        makeCommand.toggleIR(s).send();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="light") {
        logger.info(`ToggleLight on ${devId}`);
        makeCommand.toggleLight(s).send();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="stop") {
        logger.info(`stopvideo ${devId}`);
        makeCommand.stopVideo(s).send();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="reboot") {
        logger.info(`reboot ${devId}`);
        makeCommand.reboot(s).send();
        res.writeHead(204);
        res.end();
        s.close();
        return;
      }
      else if(cmd=="pancmd") {
        logger.info(`PanCmd ${n1}/${n2}/${n3} on ${devId}`);
        makeCommand.pan(s,n1,n2,n3).send();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="rescmd") {
        if(n1 != "") {
          logger.info(`rescmd ${n1} on ${devId}`);
          makeCommand.setRes(s,n1).send();
        }
        if(n2) {
          logger.info(`rescmd qlty ${n2} on ${devId}`);
          makeCommand.setQlty(s,n2).send();
        }
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="packets") {
        res.setHeader("Content-Type", `text/javascript`);
        res.write(s.getPackets());
        res.end();
        return;
      }
      else if (cmd=="rotate") {
        let curPos = config.cameras[devId]?.rotate || 0;
        let nextPos = (curPos + 1) % 4;
        logger.debug(`Rotating ${devId} to ${nextPos}`);
        config.cameras[devId].rotate = nextPos;
        res.writeHead(204);
        res.end();
        return;
      }
      else if (cmd=="mirror") {
        logger.debug(`Mirroring ${devId}`);
        config.cameras[devId].mirror = !config.cameras[devId].mirror;
        res.writeHead(204);
        res.end();
        return;
      }
      else if (cmd=="camera") {
        var tlimit;
        logger.info(`Video stream requested for camera ${devId} (exif:${conf.exif}, packetmode=${conf.fix_packet_loss})`);
        if (!s.connected) {
          res.writeHead(400);
          res.end(`Camera ${devId} offline`);
          return;
        }
        if(n1>0) {
          tlimit = setInterval( ()=>{
            responses[devId] = responses[devId].filter((r) => r !== res);
            res.end();
          } ,n1*1000);
        }
        res.on("close", () => {
          if(tlimit) clearInterval(tlimit);
          responses[devId] = responses[devId].filter((r) => r !== res);
          if(s.remConnection) s.remConnection();
          logger.info(`Video stream closed for camera ${devId}`);
        });
        res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary="${BOUNDARY}"`);
        if(conf.fix_packet_loss != 2) res.write(header);
        res.startframe=0;
        resp.push(res);
        return;
      }
      else if(cmd=="disconnect") {
        if(s.eventEmitter) s.eventEmitter.emit("disconnect");
        else s.close();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd=="zero") {
        s.zeroCounters();
        res.writeHead(204);
        res.end();
        return;
      }
      else if(cmd.match(/^[a-z0-9_]+$/) && fs.existsSync(cmd+'.html')) {
        fs.readFile(cmd+'.html', { encoding: "utf-8" }, (err,page)=>{
          if(err) { res.writeHead(500); return res.end("Error"); }
          procpage(res, page, devId);
        });
        return;
      }
    }
    res.writeHead(400);
    res.end(`Invalid command "${cmd}"`);
  });

  let devEv = discoverDevices(config.discovery_ips);

  const startSession = (s: Session) => {
    startVideoStream(s);
    logger.info(`Camera ${s.devName} is now ready to stream`);
  };

  devEv.on("discover", (rinfo: RemoteInfo, dev: DevSerial) => {
    if (dev.devId in sessions) {
      // logger.info(`Camera ${dev.devId} at ${rinfo.address} already discovered, ignoring`);
      return;
    }

    logger.info(`Discovered camera ${dev.devId} at ${rinfo.address}`);
    if(!responses[dev.devId]) responses[dev.devId] = [];
    audioResponses[dev.devId] = [];
    const s = makeSession(Handlers, dev, rinfo, startSession, 5000);
    sessions[dev.devId] = s;
    let conf = config.cameras[dev.devId] = { exif: 1, rotate: 2, mirror: 0, fix_packet_loss:1, audio: 0, ...(config.cameras.default || {}) , ...(config.cameras[dev.devId] || {}) };

    s.eventEmitter.on("disconnect", () => {
      logger.info(`Camera ${dev.devId} disconnected`);
      delete sessions[dev.devId];
    });

    function exify(buf) {
      let orientation = conf.rotate;
      orientation = conf.mirror ? oMapMirror[orientation] : oMap[orientation];
      const exifSegment = orientations[orientation];
      return addExifToJpeg(buf, exifSegment);
    }
    // For fix_packet_loss == 2, send segment immediately
    s.sendSeg=function(buf, startframe=0, cork=0) {
      if(startframe && conf.exif) buf=exify(buf);
      responses[dev.devId].forEach((res) => {
        if(cork) res.socket.cork();
        if(startframe) {
          res.write(header);
          res.started=1;
        }
        if(res.started) res.write(buf);
        if(!cork) res.socket.uncork();
      });
    };
    // For fix_packet_loss < 2, send buffered frame
    s.eventEmitter.on("frame", () => {
      let assembled;
      if(conf.exif) s.curImage[0]=exify(s.curImage[0]);
      assembled=Buffer.concat(s.curImage);
      responses[dev.devId].forEach((res) => {
        res.cork();
        res.write(assembled);
        res.write(header);
        res.uncork();
      });
    });

    if (config.cameras[dev.devId].audio) {
      s.eventEmitter.on("audio", ({ gap, data }) => {
        // ew, maybe WS?
        var b64encoded = Buffer.from(data).toString("base64");
        audioResponses[dev.devId].forEach((res) => {
          res.write("data: ");
          res.write(b64encoded);
          res.write("\n\n");
        });
      });
    }
  });

  logger.info(`Starting HTTP server on port ${port}`);
  server.listen(port);
};

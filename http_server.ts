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

    let devId, cmd, n1, n2, n3;
    [x,devId, cmd, n1, n2, n3]=urlbits;
    let s= sessions[devId] ? sessions[devId] : undefined;
    if(s) {
      if (cmd=='ui') {
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
				const page = fs.readFileSync("asd.html", { encoding: "utf-8" });
        const ui = page
          .replace(/\${id}/g, devId)
          .replace(/\${name}/g, cameraName(devId))
          .replace(/\${audio}/g, config.cameras[devId].audio ? "true" : "false");
        res.end(ui);
        return;
      }
      else if (cmd=='audio') {
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
        logger.info(`Video stream requested for camera ${devId}`);
        if (s === undefined) {
          res.writeHead(400);
          res.end(`Camera ${devId} not discovered`);
          return;
        }
        if (!s.connected) {
          res.writeHead(400);
          res.end(`Camera ${devId} offline`);
          return;
        }

        res.setHeader("Content-Type", `multipart/x-mixed-replace; boundary="${BOUNDARY}"`);
        res.write(header);

        responses[devId].push(res);
        res.on("close", () => {
          responses[devId] = responses[devId].filter((r) => r !== res);
          logger.info(`Video stream closed for camera ${devId}`);
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
    responses[dev.devId] = [];
    audioResponses[dev.devId] = [];
    const s = makeSession(Handlers, dev, rinfo, startSession, 5000);
    sessions[dev.devId] = s;
    config.cameras[dev.devId] = { rotate: 2, mirror: false, fix_packet_loss:true, audio: false, ...(config.cameras[dev.devId] || {}) };

    const header = Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\n\r\n`);

    s.eventEmitter.on("disconnect", () => {
      logger.info(`Camera ${dev.devId} disconnected`);
      delete sessions[dev.devId];
    });
    s.eventEmitter.on("frame", () => {
        // Add an EXIF header to indicate if the image should be rotated or mirrored
        let orientation = config.cameras[dev.devId].rotate;
        orientation = config.cameras[dev.devId].mirror ? oMapMirror[orientation] : oMap[orientation];
        const exifSegment = orientations[orientation];
        const jpegHeader = addExifToJpeg(s.curImage[0], exifSegment);
        const assembled = Buffer.concat([jpegHeader, ...s.curImage.slice(1)]);
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

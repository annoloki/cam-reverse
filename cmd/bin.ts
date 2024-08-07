import process from "node:process";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";

import { serveHttp } from "../http_server.js";
import { pair } from "../pair.js";
import { loadConfig, config } from "../settings.js";

import { buildLogger, logger } from "../logger.js";

const majorVersion = process.versions.node.split(".").map(Number)[0];

yargs(hideBin(process.argv))
  .command(
    "http_server",
    "start http server",
    (yargs) => {
      return yargs
        .option("color", { describe: "Use color in logs" })
        .boolean(["audio", "color"])
        .option("config_file", { describe: "Specify config file" })
        .option("log_level", { describe: "Set log level" })
        .option("discovery_ip", { describe: "Camera discovery IP address" })
        .option("port", { describe: "HTTP Port to listen on" })
        .string(["log_level", "discovery_ip", "config_file"])
        .number(["port"])
        .option("exif", { describe: "Default rotate/mirror method (1=exif, 0=css)" })
        .option("packet", { describe: "Default video packet mode (0=drop frame, 1=fix packet loss, 2=wait for packet" })
        .strict();
    },
    (argv) => {
      if (argv.config_file !== undefined) {
        loadConfig(argv.config_file);
      }
      if (argv.port) {
        config.http_server.port = argv.port;
      }
      if (argv.color !== undefined) {
        config.logging.use_color = argv.color;
      }
      if (argv.log_level !== undefined) {
        config.logging.level = argv.log_level;
      }
      if (argv.discovery_ip !== undefined) {
        config.discovery_ips = [argv.discovery_ip];
      }
      if(!config.cameras.default) config.cameras.default={};
      if (argv.exif !== undefined) config.cameras.default.exif=argv.exif;
      if (argv.packet !== undefined) config.cameras.default.fix_packet_loss=argv.packet;

      buildLogger(config.logging.level, config.logging.use_color);
      if (majorVersion < 16) {
        logger.error(`Node version ${majorVersion} is not supported, may malfunction`);
      }
      serveHttp(config.http_server.port);
    },
  )
  .command(
    "pair",
    "configure a camera",
    (yargs) => {
      return yargs
        .option("log_level", { describe: "Set log level", default: "info" })
        .option("discovery_ip", { describe: "Camera discovery IP address", default: "192.168.1.255" })
        .option("ssid", { describe: "Wifi network for the camera to connect to" })
        .option("password", { describe: "Wifi network password" })
        .demandOption(["ssid", "password"])
        .string(["ssid", "password"]);
    },
    (argv) => {
      buildLogger(argv.log_level, undefined);
      if (majorVersion < 16) {
        logger.error(`Node version ${majorVersion} is not supported, may malfunction`);
      }
      config.discovery_ips = [argv.discovery_ip];
      pair({ ssid: argv.ssid, password: argv.password });
    },
  )
  .demandCommand()
  .parseSync();

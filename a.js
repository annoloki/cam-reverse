import fs from "node:fs";
import beamcoder from "beamcoder";
import EventEmitter from "node:events";

const ee = new EventEmitter();

let demuxers = beamcoder.demuxers();
//console.log(demuxers);

ee.on("inputFrame", (f) => {});
async function imageToVideo(imagePath, duration, frameRate = 30) {
  const muxTimeBase = 90000;
  let demuxerStream = beamcoder.demuxerStream({ highwaterMark: 65536 });
  fs.createReadStream(imagePath).pipe(demuxerStream);
  // Create a demuxer for the JPEG image
  // let demuxer = await beamcoder.demuxer(imagePath);
  let demuxer = await demuxerStream.demuxer({ name: "jpeg_pipe" });

  // Read the image packet
  let packet = await demuxer.read();

  // Create a decoder for the image
  let decoder = beamcoder.decoder({ demuxer: demuxer, name: "mjpeg" });

  // Decode the image to get the frame
  let frames = await decoder.decode(packet);
  // decoder.flush();
  //console.log("frames", frames);
  let frame = frames.frames[0];
  //console.log("frame", frame.width, frame.height);

  // Create an H.264 encoder
  // https://stackoverflow.com/a/13646293/3530257
  // > the codec unit of measurement is commonly set to the interval between each frame and the next,
  // > so that frame times are successive integers.
  let encoder = beamcoder.encoder({
    name: "libx264",
    width: frame.width,
    height: frame.height,
    bit_rate: 400000,
    //qmin: 22,
    time_base: [1, frameRate],
    framerate: [frameRate, 1],
    pix_fmt: "yuv420p",
    preset: "faster",
    gop_size: 10,
    max_b_frames: 1,
  });

  let stream = beamcoder.muxerStream({});
  stream.pipe(fs.createWriteStream("test.mp4"));
  //  Create a muxer for the output video
  let muxer = stream.muxer({ format_name: "mp4" });

  //console.log(demuxer.streams[0].codecpar.extradata); // null
  let vstr = muxer.newStream({
    name: "h264",
    time_base: [1, muxTimeBase], //frameRate],
    interleaved: true,
  });

  // the Object.assign is structural (!!)
  Object.assign(vstr.codecpar, {
    width: encoder.width,
    height: encoder.height,
    format: encoder.pix_fmt,
  });

  await muxer.openIO();
  // adding "empty_moov" crashes mpv/ffmpeg
  //await muxer.initOutput({ movflags: "frag_keyframe+default_base_moof+faststart" });
  await muxer.initOutput({ movflags: "frag_keyframe" });
  console.log("inited");
  // Add a video stream to the muxer
  await muxer.writeHeader();
  console.log("header written");
  // Number of frames to encode
  let totalFrames = duration * frameRate;

  console.log("making frames", totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    frame.pts = i; // << the successive integers
    frame.dts = i; // << the successive integers
    let encodedPackets = await encoder.encode(frame);
    // console.log(encodedPackets);

    // Write the encoded packets to the output file
    for (let packet of encodedPackets.packets) {
      packet.duration = 1;
      packet.stream_index = vstr.index;
      packet.pts = (packet.pts * muxTimeBase) / frameRate;
      packet.dts = (packet.dts * muxTimeBase) / frameRate;
      //packet.pts = i;
      await muxer.writeFrame(packet);
      // outFile.write(packet.data);
    }
  }

  // Finalize the encoder and muxer
  let encodedPackets = await encoder.flush();
  // after flushing the encoder, we may hve some more packets

  // Write the encoded packets to the output file
  for (let packet of encodedPackets.packets) {
    packet.duration = 1;
    packet.stream_index = vstr.index;
    packet.pts = (packet.pts * muxTimeBase) / frameRate;
    packet.dts = (packet.dts * muxTimeBase) / frameRate;
    await muxer.writeFrame(packet);
  }
  await muxer.writeTrailer();
}

// Usage example
imageToVideo("captures/0010.jpg", 20)
  .then(() => {
    console.log("Video created successfully");
  })
  .catch(console.error);

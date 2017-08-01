import Utilities from '../lib/Utilities.js';
import Decoder from '../lib/Decoder.js';
import {MediaSourceUtil, MediaSourceConstants} from '../lib/MediaSourceUtil.js';
import Zlib from 'zlibjs';
import LZ4 from 'lz4';

// TODO: Separate into VideoDecoder class

const DEFAULT_BOX_COLORS = {
  'png': 'yellow',
  'h264': 'blue',
  'vp8': 'green',
  'rgb24': 'orange',
  'rgb32': 'red',
  'jpeg': 'purple',
  'png/P': 'indigo',
  'png/L': 'teal',
  'h265': 'khaki',
  'vp9': 'lavender',
  'mpeg4': 'black',
  'scroll': 'brown'
};

export default class Layer {
  constructor(wid, props) {
    this.props = props || {};
    this.wid = wid;
    this.canvas = null;
    this.canvas_ctx = null;
    this.video = null;
    this.offscreen_canvas = null;
    this.offscreen_canvas_ctx = null;
    this.offscreen_canvas_mode = '2d';
    this.paint_queue = [];
    this.paint_pending = 0;
    this.broadway_decoder = null;
    this.video_buffers = [];
    this.video_buffers_count = 0;
    this.broadway_paint_location = [];
    this.media_source = null;
    this.video_source_ready = false;
    this.video_source_buffer = null;
  }

  destroy() {
    this.closeVideo();
    this.closeBroadway();
    if ( this.canvas ) {
      if ( this.canvas.parentNode ) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      this.canvas = null;
    }
  }

  init(canvas, geom) {
    this.canvas = canvas;
    this.canvas_ctx = this.canvas.getContext('2d');

    this.offscreen_canvas = document.createElement('canvas');
    this.offscreen_canvas_ctx = this.offscreen_canvas.getContext('2d');

    this.updateCanvases(geom);
  }

  updateCanvases(geom) {
    if ( this.canvas ) {
      this.canvas.width = geom.w;
      this.canvas.height = geom.h;
    }
    if ( this.offscreen_canvas ) {
      this.offscreen_canvas.width = geom.w;
      this.offscreen_canvas.height = geom.h;
    }
  }

  paint() {
    const item = Array.prototype.slice.call(arguments);
    this.paint_queue.push(item);
    this.paintQueue();
  }

  paintQueue() {
    let now = Utilities.monotonicTime();
    while ((this.paint_pending === 0 || (now - this.paint_pending) >= 2000) && this.paint_queue.length > 0) {
      this.paint_pending = now;
      const item = this.paint_queue.shift();
      this.paintItem(...item);
      now = Utilities.monotonicTime();
    }
  }

  paintItem(x, y, width, height, coding, img_data, packet_sequence, rowstride, options, decode_callback) {
    var enc_width = width;
    var enc_height = height;
    var scaled_size = options.scaled_size;
    if ( scaled_size ) {
      enc_width = scaled_size[0];
      enc_height = scaled_size[1];
    }

    const paint_box = (color, px, py, pw, ph) => {
      this.offscreen_canvas_ctx.strokeStyle = color;
      this.offscreen_canvas_ctx.lineWidth = '2';
      this.offscreen_canvas_ctx.strokeRect(px, py, pw, ph);
    };

    const painted = (skip_box) => {
      this.paint_pending = 0;
      decode_callback(this.client);
      if (this.debug && !skip_box) {
        var color = DEFAULT_BOX_COLORS[coding] || 'white';
        paint_box(color, x, y, width, height);
      }
      this.paintQueue();
    };

    const paint_error = (e) => {
      console.error('error painting', coding, e);
      this.paint_pending = 0;
      decode_callback(this.client, '' + e);
      this.paintQueue();
    };

    const decodeRbg32 = () => {
      this.nonVideoPaint(coding);

      var img = this.offscreen_canvas_ctx.createImageData(width, height);
      var inflated;

      //show('options='+(options).toSource());
      if (options !== null && options.zlib > 0) {
        //show('decompressing '+img_data.length+' bytes of '+coding+'/zlib');
        inflated = new Zlib.Inflate(img_data).decompress();
        //show('rgb32 data inflated from '+img_data.length+' to '+inflated.length+' bytes');
        img_data = inflated;
      } else if (options !== null && options.lz4 > 0) {
        // in future we need to make sure that we use typed arrays everywhere...
        var d;
        if (img_data.subarray) {
          d = img_data.subarray(0, 4);
        } else {
          d = img_data.slice(0, 4);
        }

        // will always be little endian
        var length = d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
        // decode the LZ4 block
        inflated = new Buffer(length);

        var uncompressedSize;
        if (img_data.subarray) {
          uncompressedSize = LZ4.decodeBlock(img_data.subarray(4), inflated);
        } else {
          uncompressedSize = LZ4.decodeBlock(img_data.slice(4), inflated);
        }
        img_data = inflated.slice(0, uncompressedSize);
      }

      // set the imagedata rgb32 method
      if (img_data.length > img.data.length) {
        paint_error('data size mismatch: wanted ' + img.data.length + ', got ' + img_data.length + ', stride=' + rowstride);
      } else {
        img.data.set(img_data);
        this.offscreen_canvas_ctx.putImageData(img, x, y);
        painted();
      }
    };

    const decodeJpeg = () => {
      this.nonVideoPaint(coding);

      var j = new Image();
      j.onload = () => {
        if (j.width === 0 || j.height === 0) {
          paint_error('invalid image size: ' + j.width + 'x' + j.height);
        } else {
          this.offscreen_canvas_ctx.drawImage(j, x, y);
          painted();
        }
      };
      j.onerror = function() {
        paint_error('failed to load into image tag');
      };
      j.src = 'data:image/' + coding + ';base64,' + this.arrayBufferToBase64(img_data);
    };

    const decodeBroadway = () => {
      var frame = options.frame || -1;
      if (frame === 0) {
        this.closeBroadway();
      }
      if (!this.broadway_decoder) {
        this.initBroadway(enc_width, enc_height, width, height);
      }

      this.broadway_paint_location = [x, y];
      // we can pass a buffer full of NALs to decode() directly
      // as long as they are framed properly with the NAL header
      if (!Array.isArray(img_data)) {
        img_data = Array.from(img_data);
      }
      this.broadway_decoder.decode(img_data);
      // broadway decoding is synchronous:
      // (and already painted via the onPictureDecoded callback)
      painted();
    };

    const decodeMp4 = () => {
      var frame = options.frame || -1;
      if (frame === 0) {
        this.closeVideo();
      }

      if (!this.video) {
        var profile = options.profile || 'baseline';
        var level = options.level || '3.0';
        this.initVideo(width, height, coding, profile, level);
      } else {
        //keep it above the div:
        this.video.style.zIndex = this.div.css('z-index') + 1;
      }

      if (img_data.length > 0) {
        this.video_buffers.push(img_data);
        if (this.video.paused) {
          this.video.play();
        }
        this.pushVideoBuffers();
        //try to throttle input:
        var delay = Math.max(10, 50 * (this.video_buffers.length - 25));
        setTimeout(function() {
          painted();
        }, delay);
        //this._debug('video queue: ', this.video_buffers.length);
      }
    };

    const decodeScroll = () => {
      this.nonVideoPaint(coding);

      for (var i = 0, j = img_data.length;i < j;++i) {
        var scroll_data = img_data[i];
        var sx = scroll_data[0],
          sy = scroll_data[1],
          sw = scroll_data[2],
          sh = scroll_data[3],
          xdelta = scroll_data[4],
          ydelta = scroll_data[5];

        this.offscreen_canvas_ctx.drawImage(this.offscreen_canvas, sx, sy, sw, sh, sx + xdelta, sy + ydelta, sw, sh);
        if (this.debug) {
          paint_box('brown', sx + xdelta, sy + ydelta, sw, sh);
        }
      }
      painted(true);
    };

    try {
      if (coding === 'rgb32') {
        decodeRbg32();
      } else if (coding === 'jpeg' || coding === 'png') {
        decodeJpeg();
      } else if (coding === 'h264') {
        decodeBroadway();
      } else if (coding === 'h264+mp4' || coding === 'vp8+webm' || coding === 'mpeg4+mp4') {
        decodeMp4();
      } else if (coding === 'scroll') {
        decodeScroll();
      } else {
        paint_error('unsupported encoding');
      }
    } catch (e) {
      paint_error(e);
    }
  }

  draw() {
    if ( this.canvas && this.offscreen_canvas ) {
      this.canvas_ctx.drawImage(this.offscreen_canvas, 0, 0);
    }
  }

  nonVideoPaint(coding) {
    if ( this.video && this.video.style.zIndex !== '-1' ) {
      this.video.style.zIndex = '-1';
      var width = this.video.getAttribute('width');
      var height = this.video.getAttribute('height');
      this.offscreen_canvas_ctx.drawImage(this.video, 0, 0, width, height);
    }
  }

  arrayBufferToBase64(uintArray) {
    // apply in chunks of 10400 to avoid call stack overflow
    // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/apply
    var s = '';
    var skip = 10400;
    var i, len;
    if ( uintArray.subarray ) {
      for ( i = 0, len = uintArray.length; i < len; i += skip ) {
        s += String.fromCharCode.apply(null, uintArray.subarray(i, Math.min(i + skip, len)));
      }
    } else {
      for (i = 0, len = uintArray.length; i < len; i += skip ) {
        s += String.fromCharCode.apply(null, uintArray.slice(i, Math.min(i + skip, len)));
      }
    }
    return window.btoa(s);
  }

  initBroadway(enc_width, enc_height, width, height) {
    this.broadway_decoder = new Decoder({
      'rgb': true,
      'size': {
        width: enc_width,
        height: enc_height
      }
    });

    this.broadway_paint_location = [0, 0];
    this.broadway_decoder.onPictureDecoded = (buffer, p_width, p_height, infos) => {
      if ( !this.broadway_decoder ) {
        return;
      }

      var img = this.offscreen_canvas_ctx.createImageData(p_width, p_height);
      img.data.set(buffer);

      var x = this.broadway_paint_location[0];
      var y = this.broadway_paint_location[1];
      this.offscreen_canvas_ctx.putImageData(img, x, y);

      if ( enc_width !== width || enc_height !== height ) {
        this.offscreen_canvas_ctx.drawImage(this.offscreen_canvas, x, y, p_width, p_height, x, y, width, height);
      }
    };
  }

  closeBroadway() {
    this.broadway_decoder = null;
  }

  initVideo(width, height, coding, profile, level) {
    this.media_source = MediaSourceUtil.getMediaSource();

    if ( this.debug ) {
      MediaSourceUtil.addMediaSourceEventDebugListeners(this.media_source, 'video');
    }

    //<video> element:
    this.video = document.createElement('video');
    this.video.setAttribute('autoplay', true);
    this.video.setAttribute('muted', true);
    this.video.setAttribute('width', width);
    this.video.setAttribute('height', height);
    this.video.style.pointerEvents = 'all';
    this.video.style.position = 'absolute';
    this.video.style.zIndex = this.div.css('z-index') + 1;
    this.video.style.left  = '' + this.leftoffset + 'px';
    this.video.style.top = '' + this.topoffset + 'px';

    if ( this.debug ) {
      MediaSourceUtil.addMediaElementEventDebugListeners(this.video, 'video');
      this.video.setAttribute('controls', 'controls');
    }

    this.video.addEventListener('error', function() {
      console.error('video error');
    });

    this.video.src = window.URL.createObjectURL(this.media_source);
    //this.video.src = 'https://html5-demos.appspot.com/static/test.webm'
    this.video_buffers = [];
    this.video_buffers_count = 0;
    this.video_source_ready = false;

    var codec_string = '';
    if ( coding === 'h264+mp4' || coding === 'mpeg4+mp4' ) {
      //ie: 'video/mp4; codecs='avc1.42E01E, mp4a.40.2''
      codec_string = 'video/mp4; codecs="avc1.' + MediaSourceConstants.H264_PROFILE_CODE[profile] + MediaSourceConstants.H264_LEVEL_CODE[level] + '"';
    } else if ( coding === 'vp8+webm' ) {
      codec_string = 'video/webm;codecs=""vp8"';
    } else if ( coding === 'vp9+webm' ) {
      codec_string = 'video/webm;codecs="vp9"';
    } else {
      throw Error('invalid encoding: ' + coding);
    }

    this.media_source.addEventListener('sourceopen', () => {
      var vsb = this.media_source.addSourceBuffer(codec_string);
      vsb.mode = 'sequence';
      this.video_source_buffer = vsb;

      if ( this.debug ) {
        MediaSourceUtil.addSourceBufferEventDebugListeners(vsb, 'video');
      }

      vsb.addEventListener('error', (e) => {
        console.error('video source buffer error');
      });

      vsb.addEventListener('waiting', () => {
        this.pushVideoBuffers();
      });

      //push any buffers that may have accumulated since we initialized the video element:
      this.pushVideoBuffers();
      this.video_source_ready = true;
    });

    this.canvas.parentElement.appendChild(this.video);
  }

  closeVideo() {
    this.video_source_ready = false;

    if ( this.video ) {
      if ( this.media_source ) {
        try {
          if ( this.video_source_buffer ) {
            this.media_source.removeSourceBuffer(this.video_source_buffer);
          }
          this.media_source.endOfStream();
        } catch ( e ) {
          this.warn('video media source EOS error: ', e);
        }
        this.video_source_buffer = null;
        this.media_source = null;
      }
      this.video.remove();
      this.video = null;
    }
  }

  pushVideoBuffers() {
    var vsb = this.video_source_buffer;
    var vb = this.video_buffers;
    if ( !vb || !vsb || !this.video_source_ready ) {
      return;
    }

    if ( vb.length === 0 && this.video_buffers_count === 0 ) {
      return;
    }

    while ( vb.length > 0 && !vsb.updating ) {
      var buffers = vb.splice(0, 20);
      var buffer = [].concat.apply([], buffers);
      vsb.appendBuffer(new Uint8Array(buffer).buffer);
      this.video_buffers_count += buffers.length;
    }

    if ( vb.length > 0 ) {
      setTimeout(() => this.pushVideoBuffers(), 25);
    }
  }

  getClientProperties() {
    return Object.assign({
      'encodings.rgb_formats': ['RGBX', 'RGBA']
    }, this.props);
  }

  setCursor(encoding, w, h, xhot, yhot, img_data) {
    if ( !this.canvas ) {
      return;
    }

    if ( !arguments.length ) {
      this.canvas.style.cursor = 'default';
      return;
    }

    if ( encoding === 'png' ) {
      const cursor_url = 'url(\'data:image/' + encoding + ';base64,' + window.btoa(img_data) + '\')';
      this.canvas.style.cursor = cursor_url + ', default';
      this.canvas.style.cursor = cursor_url + ['', xhot, yhot].join(' ') + ', auto';
    }
  }

}

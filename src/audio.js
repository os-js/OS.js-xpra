import Utilities from '../lib/Utilities.js';
import {MediaSourceUtil, MediaSourceConstants} from '../lib/MediaSourceUtil.js';

import AV from 'av';

window.AV = AV;
window.AVXpra = require('../lib/aurora-xpra.js');

const EventHandler = OSjs.require('helpers/event-handler');

let MIN_START_BUFFERS = 4;
let MAX_BUFFERS = 250;

export default class AudioDecoder extends EventHandler {

  constructor(uuid) {
    super();

    this.uri = '';
    this.uuid = uuid;
    this.enabled = true;
    this.server_codecs = {};
    this.available_codecs = {};
    this.framework = null;
    this.codec = null;
    this.context = null;
    this.audio_buffers = [];
    this.audio_source_ready = false;
    this.audio_buffers_count = 0;
    this.audio_aurora_ctx = null;
    this.media_source = null;

    this.sources = {
      mediasource: !!MediaSourceUtil.getMediaSourceClass() && !!AV.Player.fromXpraSource,
      aurora: !!AV.Player.fromXpraSource,
      httpstream: true
    };

    this.codecs = {
      aurora: {},
      mediasource: {},
      httpstream: ['mp3']
    };
  }

  destroy() {
    if ( !this.protocol ) {
      return;
    }

    this.emit('destroy');

    if ( this.media_source ) {
      try {
        if ( this.audio_source_buffer ) {
          this.media_source.removeSourceBuffer(this.audio_source_buffer);
          this.audio_source_buffer = null;
        }
        if ( this.media_source.readyState === 'open' ) {
          this.media_source.endOfStream();
        }
      } catch ( e ) {}
    }

    if ( this.$audio ) {
      this.$audio.src = '';
      this.$audio.load();
      try {
        this.$audio.parentNode.removeChild(this.$audio);
      } catch (e) {}
    }

    this.audio_aurora_ctx = null;
    this.media_source = null;
  }

  init(uri) {
    if ( !this.enabled ) {
      return;
    }

    this.uri = uri;

    console.group('XpraClient', 'AudioDecoder::init()');

    this.$audio = document.createElement('audio');
    this.$audio.setAttribute('autoplay', true);
    this.$audio.setAttribute('controls', false);
    this.$audio.setAttribute('loop', true);
    this.$audio.style.position = 'absolute';
    this.$audio.style.top = '-10000px';
    this.$audio.style.left = '-10000px';
    this.$audio.style.width = '1px';
    this.$audio.style.height = '1px';
    this.$audio.addEventListener('error', (e) => {
      console.error('audio source error', e);
    });
    this.$audio.addEventListener('play', (e) => {
      console.warn('audio source started playing', e);
    });
    document.body.appendChild(this.$audio);

    this.context = Utilities.getAudioContext();

    if ( this.sources.mediasource ) {
      this.codecs.mediasource = MediaSourceUtil.getMediaSourceAudioCodecs([]);

      console.debug('Checking "mediasource"', this.codecs.mediasource);
      Object.keys(this.codecs.mediasource).forEach((n) => {
        this.available_codecs[n] = this.codecs.mediasource[n];
      });
    }

    if ( this.sources.aurora ) {
      this.codecs.aurora = MediaSourceUtil.getAuroraAudioCodecs();

      console.debug('Checking "aurora"', this.codecs.aurora);
      Object.keys(this.codecs.aurora).forEach((n) => {
        if ( !(n in this.available_codecs) ) {
          this.available_codecs[n] = this.codecs.aurora[n];
        }
      });
    }

    if ( this.sources.httpstream ) {
      console.debug('Checking "httpstream"', this.codecs.httpstream);
      this.codecs.httpstream.forEach((n) => {
        this.available_codecs[n] = n;
      });
    }

    if ( !Object.keys(this.available_codecs).length ) {
      console.warn('No audio codecs found');
      this.enabled = false;
      this.codec = null;
    }

    console.debug('Found audio codecs', this.available_codecs);

    if ( !(this.codec in this.available_codecs) ) {
      const defaultCodec = MediaSourceUtil.getDefaultAudioCodec(this.available_codecs);
      console.debug('No codec was found, trying', defaultCodec);
      this.codec = defaultCodec;

      if ( this.codec ) {
        if ( this.sources.mediasource && (this.codec in this.codecs.mediasource) ) {
          this.framework = 'mediasource';
        } else if ( this.sources.aurora && !Utilities.isIE() ) {
          this.framework = 'aurora';
        } else if ( this.sources.httpstream ) {
          this.framework = 'http-stream';
        } else {
          console.warn('Did not find any framework...');
        }
      }
    }

    console.info('Codecs', this.available_codecs, 'from', this.codecs);
    console.info('Using audio framework', this.framework, this.codec);

    console.groupEnd();
  }

  setup(hello) {
    console.group('XpraClient', 'AudioDecoder::setup()');

    if ( hello['sound.send'] ) {
      this.server_codecs = hello['sound.encoders'] || [];
      if ( !this.server_codecs.length ) {
        this.enabled = false;
      } else {
        console.debug('Server is sending audio with', this.server_codecs);

        if ( this.server_codecs.indexOf(this.codec) === -1 ) {
          const pref = MediaSourceConstants.PREFERRED_CODEC_ORDER;
          const found = pref.find((p) => {
            console.debug('Trying', p, '...');
            if ( (p in this.available_codecs) && this.server_codecs.indexOf(p) !== -1 ) {
              return true;
            }
            return false;
          });

          if ( found ) {
            if ( this.codecs.mediasource[found] ) {
              this.codec = 'mediasource';
            } else {
              this.codec = 'aurora';
            }
          } else {
            this.codec = null;
            console.debug('... but it looks like our codec was not supported');
          }
        }
      }
    } else {
      this.enabled = false;
    }

    if ( !this.codec ) {
      this.enabled = false;
    }

    if ( this.enabled ) {
      console.info('We\'re using audio with', this.framework, this.codec);

      if ( this.framework === 'http-stream' ) {
        this.$audio.src = this.uri.replace(/^ws/, 'http') + '/audio.mp3?uuid=' + this.uuid;
        console.info('Streaming audio from', this.$audio.src);
      } else if ( this.framework === 'mediasource' ) {
        this.media_source = MediaSourceUtil.getMediaSource();
        this.$audio.src = window.URL.createObjectURL(this.media_source);
        console.info('Starting streaming audio from', this.$audio.src);

        this.media_source.addEventListener('sourceopen', (e) => {
          console.error(e);
          this.destroy();
        });

        this.media_source.addEventListener('sourceopen', (e) => {
          console.warn('audio source was opened', e);

          if ( this.audio_source_ready ) {
            return;
          }

          const codec_string = MediaSourceConstants.CODEC_STRING[this.codec];
          if ( !codec_string  ) {
            this.destroy();
            return;
          }

          try {
            this.audio_source_buffer = this.media_source.addSourceBuffer(codec_string);
          } catch (e) {
            this.destroy();
            return;
          }

          this.audio_source_buffer.mode = 'sequence';

          this.audio_source_buffer.addEventListener('error', (e) => {
            console.error(e);
          });

          this.emit('ready', [this.codec]);
          this.audio_source_ready = true;
        });
      } else {
        this.audio_aurora_ctx = AV.Player.fromXpraSource();
        this.emit('ready', [this.codec]);
        console.info('Starting streaming audio from', this.audio_aurora_ctx);
      }
    } else {
      console.warn('Could not enable audio');
    }

    console.groupEnd();
  }

  play() {
    console.info('GOT SIGNAL TO START PLAYING');
    if ( this.framework === 'mediasource' ) {
      this.$audio.play();
    } else {
      this.audio_aurora_ctx.play();
    }
  }

  handle(codec, buf, options, metadata) {
    const isReady = () => {
      if ( this.framework === 'mediasource' ) {
        const asb = this.audio_source_buffer;
        return !!asb && !asb.updating;
      }

      return !!this.audio_aurora_ctx;
    };

    if ( codec !== this.codec ) {
      return;
    }

    if ( options['start-of-stream'] === 1 ) {
      this.play();
      return;
    }

    if ( options['end-of-stream'] === 1 ) {
      this.destroy();
    }

    if ( this.audio_buffers.length >= MAX_BUFFERS ) {
      this.destroy();
      return;
    }

    let i, j, v;
    if ( metadata ) {
      for ( i = 0; i < metadata.length; i++ ) {
        /* eslint new-cap: "off" */
        this.audio_buffers.push(Utilities.StringToUint8(metadata[i]));
      }
      MIN_START_BUFFERS = 1;
    }

    if ( buf ) {
      this.audio_buffers.push(buf);
    }

    var ab = this.audio_buffers;
    if ( isReady() && (this.audio_buffers_count > 0 || ab.length >= MIN_START_BUFFERS) ) {
      if ( ab.length === 1 ) {
        buf = ab[0];
      } else {
        var size = 0;
        for ( i = 0, j = ab.length; i < j; ++i ) {
          size += ab[i].length;
        }

        buf = new Uint8Array(size);
        size = 0;
        for ( i = 0, j = ab.length; i < j; ++i ) {
          v = ab[i];
          if ( v.length > 0 ) {
            buf.set(v, size);
            size += v.length;
          }
        }
      }

      this.audio_buffers_count += 1;
      this.audio_buffers = [];
      if ( this.framework === 'mediasource' ) {
        this.audio_source_buffer.appendBuffer(buf);
      } else {
        this.audio_aurora_ctx.asset.source._on_data(buf);
      }
    }
  }

  getAvailableCodecs() {
    return this.available_codecs;
  }

}

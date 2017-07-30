
import XpraProtocol from '../lib/Protocol.js';
import Utilities from '../lib/Utilities.js';
import {get_event_modifiers, NUMPAD_TO_NAME, KEY_TO_NAME, CHAR_TO_NAME, CHARCODE_TO_NAME} from '../lib/Keycodes.js';

import forge from 'node-forge';
import lz4 from 'lz4';

const EventHandler = OSjs.require('helpers/event-handler');

///////////////////////////////////////////////////////////////////////////////
// HELPERS
///////////////////////////////////////////////////////////////////////////////

function translateModifiers(modifiers, swap_keys) {
  var alt = 'mod1';
  var meta = 'mod1';
  var control = 'control';
  //swap
  if ( swap_keys) {
    meta = 'control';
    control = 'mod1';
  }

  var new_modifiers = modifiers.slice();
  var index = modifiers.indexOf('alt');
  if ( index >= 0 ) {
    new_modifiers[index] = alt;
  }
  index = modifiers.indexOf('meta');
  if ( index >= 0 ) {
    new_modifiers[index] = meta;
  }
  index = modifiers.indexOf('control');
  if ( index >= 0 ) {
    new_modifiers[index] = control;
  }
  return new_modifiers;
}

function getKeyModifiers(ev, caps_lock, num_lock, num_lock_mod, swap_keys) {
  const modifiers = get_event_modifiers(event);
  if ( caps_lock ) {
    modifiers.push('lock');
  }
  if ( num_lock && num_lock_mod ) {
    modifiers.push(num_lock_mod);
  }
  return translateModifiers(modifiers, swap_keys);
}

function getKeyPress(pressed, ev, keycode, caps_lock, num_lock, swap_keys) {
  var keyname = ev.code || '';
  if ( keycode === 229 ) {
    //this usually fires when we have received the event via "oninput" already
    return false;
  }
  var str = event.key || String.fromCharCode(keycode);

  //sync numlock FIXME
  if ( keycode === 144 && pressed ) {
    num_lock = !num_lock;
  }

  //special case for numpad,
  //try to distinguish arrowpad and numpad:
  //(for arrowpad, keyname==str)
  if ( keyname !== str && (str in NUMPAD_TO_NAME) ) {
    keyname = NUMPAD_TO_NAME[str];
    num_lock = ('0123456789.'.indexOf(keyname)) >= 0;
  } else if ( keyname in KEY_TO_NAME ) {
    //some special keys are better mapped by name:
    keyname = KEY_TO_NAME[keyname];
  } else if ( str in CHAR_TO_NAME ) {
    //next try mapping the actual character
    keyname = CHAR_TO_NAME[str];
  } else if ( keycode in CHARCODE_TO_NAME ) {
    //fallback to keycode map:
    keyname = CHARCODE_TO_NAME[keycode];
  }

  var DOM_KEY_LOCATION_RIGHT = 2;
  if ( keyname.match('_L$') && event.location === DOM_KEY_LOCATION_RIGHT ) {
    keyname = keyname.replace('_L', '_R');
  }

  var raw_modifiers = get_event_modifiers(event);
  var modifiers = translateModifiers(raw_modifiers, swap_keys);
  var keyval = keycode;
  var group = 0;

  var shift = modifiers.indexOf('shift') >= 0;
  if ( (caps_lock && shift) || (!caps_lock && !shift) ) {
    str = str.toLowerCase();
  }

  if ( swap_keys ) {
    if (keyname === 'Control_L') {
      keyname = 'Meta_L';
      str = 'meta';
    } else if ( keyname === 'Meta_L' ) {
      keyname = 'Control_L';
      str = 'control';
    } else if ( keyname === 'Control_R' ) {
      keyname = 'Meta_R';
      str = 'meta';
    } else if ( keyname === 'Meta_R' ) {
      keyname = 'Control_R';
      str = 'control';
    }
  }

  return {keyval, keyname, str, group, modifiers, caps_lock, num_lock};
}

const handleWheel = (() => {
  let wheel_delta_x, wheel_delta_y;

  return function(ev, cb) {
    var wheel = Utilities.normalizeWheel(ev);
    var px = Math.min(1200, wheel.pixelX);
    var py = Math.min(1200, wheel.pixelY);
    var apx = Math.abs(px);
    var apy = Math.abs(py);

    //generate a single event if we can, or add to accumulators:
    if ( apx >= 40 && apx <= 160 ) {
      wheel_delta_x = (px > 0) ? 120 : -120;
    } else {
      wheel_delta_x += px;
    }

    if ( apy >= 40 && apy <= 160 ) {
      wheel_delta_y = (py > 0) ? 120 : -120;
    } else {
      wheel_delta_y += py;
    }

    var wx = Math.abs(wheel_delta_x);
    var wy = Math.abs(wheel_delta_y);
    var btn_x = (wheel_delta_x >= 0) ? 6 : 7;
    var btn_y = (wheel_delta_y >= 0) ? 5 : 4;

    while ( wx >= 120 ) {
      wx -= 120;
      cb(btn_x, true);
      cb(btn_x, false);
    }

    while ( wy >= 120 ) {
      wy -= 120;
      cb(btn_y, true);
      cb(btn_y, false);
    }

    wheel_delta_x = (wheel_delta_x >= 0) ? wx : -wx;
    wheel_delta_y = (wheel_delta_y >= 0) ? wy : -wy;
  };
})();

///////////////////////////////////////////////////////////////////////////////
// CLIENT
///////////////////////////////////////////////////////////////////////////////

/**
 * XpraClient
 *
 * This is the Xpra OS.js Client Module.
 *
 * It's a modified version of the official one.
 */
export default class XpraClient extends EventHandler {

  constructor() {
    super('XpraClient');

    this.protocol = null;
    this.queue_draw_packets = false;
    this.dQ = [];
    this.dQ_interval_id = null;
    this.process_interval = 4;
    this.caps_lock = false;
    this.swap_keys = false;
    this.num_lock = false;
    this.num_lock_mod = false;
    this.last_mouse_x = null;
    this.last_mouse_y = null;
    this.desktop = {w: 800, h: 600};
  }

  destroy() {
    this.disconnect();
  }

  /**
   * Connect to given URI
   * @param {String} uri Connection uri
   */
  connect(uri) {
    const map = {
      open: () => {
        this.emit('connect');
        this.send(['hello', this.getCapabilities()]);
      },
      draw: this.draw,
      disconnect: this.disconnect,
      cursor: this.cursor,
      ping: (echotime) => {
        this.send(['ping_echo', echotime, 0, 0, 0, 0]);
      },
      ping_echo: (echotime) => {
        this.last_ping_echoed_time = echotime;
      }
    };

    this.protocol = new XpraProtocol();
    this.protocol.set_packet_handler((packet, ctx) => {
      const command = packet[0];
      const args = packet.splice(1);

      if ( ['ping', 'draw', 'cursor'].indexOf(command) === -1 ) {
        console.info('RECV', command, args);
      }

      if ( map[command] ) {
        map[command].apply(this, args);
      } else {
        this.emit(command, args);
      }
    });

    this.protocol.open(uri);
  }

  /**
   * Gets the keycode map
   * @return {Array}
   */
  getKeyCodes() {
    return Object.keys(CHARCODE_TO_NAME).map((c) => {
      return [parseInt(c, 10), CHARCODE_TO_NAME[c], parseInt(c, 10), 0, 0];
    });
  }

  /**
   * Gets the monitor DPI
   * @return {Number}
   */
  getDPI() {
    // FIXME: Check fallback via DOM element
    if ( 'deviceXDPI' in window.screen ) {
      return (screen.systemXDPI + screen.systemYDPI) / 2;
    }

    return 96;
  }

  /**
   * Gets the desktop size
   * @return {Number[]}
   */
  getDesktopSize() {
    return [this.desktop.width, this.desktop.height];
  }

  /**
   * Gets the screen size
   * @return {Array}
   */
  getScrenSize() {
    const dpi = this.getDPI();
    const screen_size = this.getScrenSize();
    const wmm = Math.round(screen_size[0] * 25.4 / dpi);
    const hmm = Math.round(screen_size[1] * 25.4 / dpi);
    const monitor = ['Canvas', 0, 0, screen_size[0], screen_size[1], wmm, hmm];
    const screen = ['HTML', screen_size[0], screen_size[1],
      wmm, hmm,
      [monitor],
      0, 0, screen_size[0], screen_size[1]
    ];
    return [screen];
  }

  /**
   * Get the client capabilities
   * @return {Object}
   */
  getCapabilities() {
    const capabilities = {
      version: Utilities.VERSION,
      'platform': Utilities.getPlatformName(),
      'platform.name': Utilities.getPlatformName(),
      'platform.processor': Utilities.getPlatformProcessor(),
      'platform.platform': navigator.appVersion,
      'session-type': Utilities.getSimpleUserAgentString(),
      'session-type.full': navigator.userAgent,
      'namespace': true,
      'share': false,
      'steal': true,
      'client_type': 'HTML5',
      'encoding.generic': true,
      'username': '',
      'uuid': Utilities.getHexUUID(),
      'argv': [window.location.href],
      'digest': ['hmac', 'hmac+md5', 'xor'].concat(Object.keys(forge.md.algorithms).map((k) => {
        return 'hmac' + k;
      })),
      'zlib': true,
      'lzo': false,
      'compression_level': 1,
      'rencode': false,
      'bencode': true,
      'yaml': false,
      'lz4': true,
      'lz4.js.version': lz4.version,
      'encoding.rgb_lz4': true,

      'auto_refresh_delay': 500,
      'randr_notify': true,
      'sound.server_driven': true,
      'server-window-resize': true,
      'notify-startup-complete': true,
      'generic-rgb-encodings': true,
      'window.raise': true,
      'window.initiate-moveresize': true,
      'metadata.supported': [
        'fullscreen', 'maximized', 'above', 'below',
        //'set-initial-position', 'group-leader',
        'title', 'size-hints', 'class-instance', 'transient-for', 'window-type',
        'decorations', 'override-redirect', 'tray', 'modal', 'opacity'
        //'shadow', 'desktop',
      ],
      'encodings': ['jpeg', 'png', 'rgb', 'rgb32'],
      'raw_window_icons': true,
      'encoding.icons.max_size': [30, 30],
      'encodings.core': ['jpeg', 'png', 'rgb', 'rgb32'],
      'encodings.rgb_formats': ['RGBX', 'RGBA'],
      'encodings.window-icon': ['png'],
      'encodings.cursor': ['png'],
      'encoding.generic': true,
      'encoding.transparency': true,
      'encoding.client_options': true,
      'encoding.csc_atoms': true,
      'encoding.scrolling': true,
      'encoding.color-gamut': Utilities.getColorGamut(),
      //video stuff:
      'encoding.video_scaling': true,
      'encoding.full_csc_modes': {
        'h264': ['YUV420P'],
        'mpeg4+mp4': ['YUV420P'],
        'h264+mp4': ['YUV420P'],
        'vp8+webm': ['YUV420P']
      },
      'encoding.x264.YUV420P.profile': 'baseline',
      'encoding.h264.YUV420P.profile': 'baseline',
      'encoding.h264.YUV420P.level': '2.1',
      'encoding.h264.cabac': false,
      'encoding.h264.deblocking-filter': false,
      'encoding.h264+mp4.YUV420P.profile': 'main',
      'encoding.h264+mp4.YUV420P.level': '3.0',
      //prefer native video in mp4/webm container to broadway plain h264:
      'encoding.h264.score-delta': -20,
      'encoding.h264+mp4.score-delta': 50,
      'encoding.mpeg4+mp4.score-delta': 50,
      'encoding.vp8+webm.score-delta': 50,

      'sound.receive': true,
      'sound.send': false,
      'sound.decoders': {},
      'sound.bundle-metadata': true,
      // encoding stuff
      'encoding.rgb24zlib': true,
      'encoding.rgb_zlib': true,
      'windows': true,
      //partial support:
      'keyboard': true,
      'xkbmap_layout': 'no',
      'xkbmap_keycodes': this.getKeyCodes(),
      'xkbmap_print': '',
      'xkbmap_query': '',
      'desktop_size': this.getDesktopSize(),
      'desktop_mode_size': this.getDesktopSize(),
      'screen_sizes': this.getDesktopSize(),
      'dpi': this.getDPI(),
      //not handled yet, but we will:
      'clipboard_enabled': false,
      'clipboard.want_targets': true,
      'clipboard.greedy': true,
      'clipboard.selections': ['CLIPBOARD', 'PRIMARY'],
      'notifications': true,
      'cursors': true,
      'bell': true,
      'system_tray': true,
      //we cannot handle this (GTK only):
      'named_cursors': false,
      // printing
      'file-transfer': false,
      'printing': false,
      'file-size-limit': 10
    };

    console.info('CAPABILITIES', capabilities);

    return capabilities;
  }

  /**
   * Process the draw queue
   * @param {Number} wid Window ID
   * @param {Number} x X position
   * @param {Number} y Y position
   * @param {Number} width Width
   * @param {Number} height Height
   * @param {String} coding Encoding
   * @param {Buffer} data Data
   * @param {Number} packet_sequence Packet Sequence
   * @param {Boolean} rowstride Rowstride
   * @param {Object} options Options
   */
  processDrawQueue(wid, x, y, width, height, coding, data, packet_sequence, rowstride, options) {
    options = options || {};

    var start = Utilities.monotonicTime();
    var decode_time = -1;

    try {
      this.emit('paint', [
        wid, x, y, width, height, coding, data, packet_sequence, rowstride, options, (ctx, error) => {
          var flush = options.flush || 0;
          if ( !flush ) {
            window.requestAnimationFrame(() => this.emit('redraw', [wid]));
          }

          if ( error ) {
            decode_time = -1;
            window.requestAnimationFrame(() => this.emit('redraw', [wid]));
          } else {
            decode_time = Math.round(Utilities.monotonicTime() - start);
          }

          this.send(['damage-sequence', packet_sequence, wid, width, height, decode_time, error || '']);
        }
      ]);
    } catch (e) {
      this.send(['damage-sequence', packet_sequence, wid, width, height, -1, String(e)]);
      console.error(e);
      window.requestAnimationFrame(() => this.emit('redraw', [wid]));
    }
  }

  /**
   * Process a key
   * @param {Number} wid Window ID
   * @param {Boolean} pressed Key was pressed
   * @param {Event} ev Browser event
   * @param {Number} keycode Keycode
   * @return {Boolean}
   */
  processKey(wid, pressed, ev, keycode) {
    const result = getKeyPress(pressed, ev, keycode, this.caps_lock, this.num_lock, this.swap_keys);
    if ( result ) {
      const {keyval, keyname, str, group, modifiers, caps_lock, num_lock} = result;

      this.send(['key-action', wid, keyname, pressed, modifiers, keyval, str, keycode, group]);

      this.caps_lock = caps_lock;
      this.num_lock = num_lock;
    }

    return false;
  }

  /**
   * Process a key modifier
   * @param {Number} wid Window ID
   * @param {Event} ev Browser event
   * @param {Number} code Keycode
   */
  processKeyEvent(wid, ev, code) {
    /* PITA: this only works for keypress event... */
    const modifiers = getKeyModifiers(ev, this.caps_lock, this.num_lock, this.num_lock_mod, this.swap_keys);
    const shift = modifiers.indexOf('shift') >= 0;
    if ( code >= 97 && code <= 122 && shift ) {
      this.caps_lock = true;
    } else if ( code >= 65 && code <= 90 && !code ) {
      this.caps_lock = true;
    } else {
      this.caps_lock = false;
    }
  }

  /**
   * Process mouse
   * @param {Number} wid Window ID
   * @param {Event} ev Browser event
   * @param {Boolean} pressed Button was pressed
   * @param {Boolean} wheel Wheel was used
   * @param {Number} topMargin The window offset
   */
  processMouse(wid, ev, pressed, wheel, topMargin) {
    const modifiers = [];
    const buttons = [];

    let x = ev.clientX;
    let y = ev.clientY - topMargin;

    if ( pressed === null ) {
      if ( isNaN(x) || isNaN(y) ) {
        if ( !isNaN(this.last_mouse_x) && !isNaN(this.last_mouse_y) ) {
          x = this.last_mouse_x;
          y = this.last_mouse_y;
        } else {
          x = 0;
          y = 0;
        }
      } else {
        this.last_mouse_x = x;
        this.last_mouse_y = y;
      }

      this.send(['pointer-position', wid, [x, y], modifiers, buttons]);

      return;
    }

    if ( wheel === true ) {
      handleWheel(ev, (button, pressed) => {
        setTimeout(() => {
          this.send(['button-action', wid, button, pressed, [x, y], modifiers, buttons]);
        }, 1);
      });
      return;
    }

    let button = 0;
    if ( 'which' in ev ) {
      button = Math.max(0, ev.which);
    } else if ( 'button' in ev ) {
      button = Math.max(0, ev.button) + 1;
    }

    this.send(['button-action', wid, button, pressed, [x, y], modifiers, buttons]);
  }

  /**
   * Handles mouse cursor
   * @param {String} encoding Encoding
   * @param {Number} x X position
   * @param {Number} y Y position
   * @param {Number} w Width
   * @param {Number} h Height
   * @param {Number} xhot X
   * @param {Number} yhot Y
   * @param {*} baz Unknown
   * @param {String} img_data Encoded image data
   */
  cursor(encoding, x, y, w, h, xhot, yhot, baz, img_data) {
    if ( arguments.length > 7  ) {
      if ( encoding !== 'png' ) {
        console.warn('invalid cursor encoding: ' + encoding);
        return;
      }

      this.emit('cursor', [encoding, w, h, xhot, yhot, img_data]);
    } else {
      this.emit('reset-cursor');
    }
  }

  /**
   * Do the drawing
   */
  draw() {
    if ( this.queue_draw_packets ) {
      if ( this.dQ_interval_id === null ) {
        this.dQ_interval_id = setInterval(() => {
          const item = this.dQ.shift();
          this.processDrawQueue(...item);
        }, this.process_interval);
      }

      this.dQ[this.dQ.length] = [...arguments];
    } else {
      this.processDrawQueue(...arguments);
    }
  }

  /**
   * Send a packet
   * @param {Array} packet The Packet
   */
  send(packet) {
    if ( ['ping_echo', 'button-action', 'key-action', 'damage-sequence', 'pointer-position'].indexOf(packet[0]) === -1 ) {
      console.info('SEND', packet);
    }

    if ( this.protocol ) {
      this.protocol.send(...arguments);
    }
  }

  /**
   * Disconnects client
   */
  disconnect() {
    if ( this.protocol ) {
      this.protocol = this.protocol.close();
      this.emit('disconnect');
    }
  }

  /**
   * Set the desktop size
   * @param {Object} geom Geometry
   */
  setDesktopSize(geom) {
    this.desktop = geom;
  }

}


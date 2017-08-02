import XpraClient from './xpra.js';
import ApplicationXpraWindow from './window.js';
import Layer from './layer.js';

const Application = OSjs.require('core/application');
const Window = OSjs.require('core/window');
const WindowManager = OSjs.require('core/window-manager');
const Dialog = OSjs.require('core/dialog');
const Menu = OSjs.require('gui/menu');
const Locales = OSjs.require('core/locales');
const Notification = OSjs.require('gui/notification');

///////////////////////////////////////////////////////////////////////////////
// APPLICATION
///////////////////////////////////////////////////////////////////////////////

export default class ApplicationXpra extends Application {

  constructor(args, metadata) {
    super('ApplicationXpra', args, metadata, {}, {
      closeWithMain: false
    });

    this.quitting = false;
    this.client = null;
    this.map = {};
  }

  destroy() {
    if ( this.client ) {
      this.client = this.client.destroy();
    }

    Notification.removeIcon('Xpra');

    return super.destroy(...arguments);
  }

  /*
   * Quit the application
   */
  quit() {
    this.quitting = true;
    this.destroy();
  }

  /*
   * Initialize Application
   */
  init(settings, metadata) {
    super.init(...arguments);

    // Initialize client
    this.createClient();
    this.createConnection();

    // Hook into WindowManager
    const setDesktopSize = () => {
      const geom = WindowManager.instance.getWindowSpace();
      this.client.setDesktopSize(geom);
    };

    setDesktopSize();

    WindowManager.instance._on('resize', setDesktopSize);

    // Make a notification icon
    const createMenu = (ev) => {
      Menu.create([{
        title: this._getArgument('uri'),
        disabled: true
      }, {
        title: Locales._('LBL_EXIT'),
        onClick: () => this.quit()
      }, {
        title: Locales._('LBL_WINDOWS'),
        menu: this._getWindows().map((win) => {
          return {
            title: win._getTitle(),
            onClick: () => win._focus()
          };
        })
      }], ev);
    };

    Notification.createIcon('Xpra', {
      icon: this._getResource('icon_color.png'),
      onClick: createMenu,
      onContextMenu: createMenu
    });
  }

  /*
   * Creates a new connection
   */
  createConnection() {
    if ( !this.client ) {
      return;
    }

    const connect = (uri) => {
      this.client.connect(uri);
      this._setArgument('uri', uri);
    };

    let uri = this._getArgument('uri');
    if ( uri ) {
      connect(uri);
    } else {
      Dialog.create('Input', {
        title: 'Xpra Connection Dialog',
        message: 'Enter the server address to connect to',
        value: 'ws://localhost:10000'
      }, (ev, btn, value) => {
        if ( btn === 'ok' && value ) {
          connect(value);
        } else {
          this.destroy();
        }
      });
    }
  }

  /*
   * Creates a new Xpra client
   */
  createClient() {
    if ( this.client ) {
      return;
    }

    const findOverlay = (wid) => this.map[wid];

    const createWindow = (wid, x, y, w, h, meta, props) => {
      console.info('XpraApplication', 'Creating window', [wid, x, y, w, h, meta, props]);
      const win = new ApplicationXpraWindow({
        wid: wid,
        w: w,
        h: h,
        x: x,
        y: y,
        props: props,
        meta: meta
      }, this, this.__metadata);

      win._on('inited', () => {
        const geom = win.getGeometry();
        const props = win.getClientProperties();

        win.addEvents(wid, win.canvas);

        this.client.send(['map-window', wid, geom.x, geom.y, geom.w, geom.h, props]);

        win._focus();
      });

      win._on('keydown', (ev, code) => {
        return this.client.processKey(wid, true, ev, code);
      });

      win._on('keyup', (ev, code) => {
        return this.client.processKey(wid, false, ev, code);
      });

      win._on('keypress', (ev, code, shiftKey, ctrlKey, altKey) => {
        return this.client.processKeyPress(wid, ev, code);
      });

      win._on('resized, moved, maximize, restore', () => {
        const geom = win.getGeometry();
        const props = win.getClientProperties();

        win.layer.updateCanvases(geom);

        this.client.send(['configure-window', wid, geom.x, geom.y, geom.w, geom.h, props]);
      });

      win._on('destroy', () => {
        if ( !this.quitting ) {
          this.client.send(['close-window', wid]);
        }
      });

      win._on('focus', () => {
        this.client.send(['focus', wid]);
      });

      return this._addWindow(win);
    };

    this.client = new XpraClient();

    this.client.on('disconnect', () => {
      Notification.create({
        icon: this._getResource('icon_color.png'),
        title: 'Disconnected from Xpra',
        message: this._getArgument('uri')
      });
      Object.keys(this.map).forEach((w) => this.map[w].destroy());
    });

    this.client.on('connect', () => {
      Notification.create({
        icon: this._getResource('icon_color.png'),
        title: 'Connected to Xpra',
        message: this._getArgument('uri')
      });
    });

    this.client.on('window-metadata', (wid, meta) => {
      const found = findOverlay(wid);
      if ( found instanceof Window ) {
        if ( meta.title ) {
          found._setTitle(meta.title);
        }
      }
    });

    this.client.on('window-icon', (wid, w, h, encoding, data) => {
      const found = findOverlay(wid);
      if ( found instanceof Window ) {
        if ( encoding === 'png' ) {
          const src = 'data:image/' + encoding + ';base64,' + found.layer.arrayBufferToBase64(data);
          found._setIcon(src);
        }
      }
    });

    this.client.on('window-move-resize', (wid, x, y, w, h) => {
      const found = findOverlay(wid);
      if ( found instanceof Window ) {
        found._resize(w, h);
        found.move(x, y);
      }
    });

    this.client.on('window-resized', (wid, w, h) => {
      const found = findOverlay(wid);
      if ( found instanceof Window ) {
        found._resize(w, h);
      }
    });

    this.client.on('raise-window', (wid) => {
      const found = findOverlay(wid);
      if ( found instanceof Window ) {
        found._focus();
      }
    });

    this.client.on('lost-window', (wid) => {
      const found = this.map[wid];
      if ( found  ) {
        if ( found instanceof Window ) {
          found.removeOverlay(wid);
        }
        found.destroy();

        delete this.map[wid];
      }
    });

    this.client.on('configure-override-redirect', (wid, x, y, w, h, meta, props) => {
      const redirect = this.map[wid];
      if ( redirect ) {
        redirect.updateCanvases({w, h});
      }
    });

    this.client.on('new-override-redirect', (wid, x, y, w, h, meta, props) => {
      if ( this.map[wid] ) {
        return;
      }

      const parentWid = meta['transient-for'];
      const pwin = this.map[parentWid];
      if ( pwin instanceof Window ) {
        this.map[wid] = new Layer(wid, props);
        pwin.addOverlay(wid, this.map[wid], x, y, w, h);
      } else {
        console.warn('TODO');
      }
    });

    this.client.on('new-window', (wid, x, y, w, h, meta, props) => {
      this.map[wid] = createWindow(wid, x, y, w, h, meta, props);
    });

    this.client.on('redraw', (wid) => {
      const found = findOverlay(wid);
      if ( found ) {
        const instance = found instanceof Window ? found.layer : found;
        instance.draw();
      }
    });

    this.client.on('cursor', (encoding, w, h, xhot, yhot, img_data) => {
      this._getWindows().forEach((w) => {
        w.layer.setCursor(encoding, w, h, xhot, yhot, img_data);
      });
    });

    this.client.on('reset-cursor', () => {
      this._getWindows().forEach((w) => {
        w.layer.setCursor();
      });
    });

    this.client.on('paint', (wid, x, y, width, height, coding, data, packet_sequence, rowstride, options, cb) => {
      const found = findOverlay(wid);
      if ( found ) {
        const instance = found instanceof Window ? found.layer : found;
        instance.paint(x, y, width, height, coding, data, packet_sequence, rowstride, options, cb);
      }
    });
  }
}


# Xpra client for OS.js (v2.1.0)

This is a modified version of the Xpra HTML5 client that lets you run your Linux applications in OS.js.

**THIS IS A VERY EARLY EXPERIMENT. MANY THINGS WILL CHANGE**

[![YouTube Video](https://img.youtube.com/vi/c0safRR0ldM/0.jpg)](https://www.youtube.com/watch?v=c0safRR0ldM)

## Usage

You'll need:

* Xpra installed
* Websockify (**with the python module**)
* python-dbus, python-gobject

At the moment you'll have to manually start a process, for example Firefox:

```
xpra --no-daemon --bind-tcp=127.0.0.1:10000 --start=firefox --html=on start :2
```

If you want audio, add the `--speaker=on` argument. Only standard mediasource via opus+mka has been tested, so this might not work properly. You have been warned :)

## Working

* Window creation and events
* Overlays (like menus, tooltips and general popupus)
* Cursors and Icons
* Mouse input
* Keyboard input
* Audio streaming

## TODO

* SSL
* Overlay keyboard events
* Launcher via Service
* Clipboard
* Printer
* Language Change
* Macro handling from original source

## LICENSE

See `LICENSE.md` as this package contains mixed licenses.

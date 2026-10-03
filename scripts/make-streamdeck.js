#!/usr/bin/env node
'use strict';
// Writes the Stream Deck plugin's generated files; run it after changing
// streamdeck/*.sdPlugin/keys.js or the layout below:
//
//   imgs/keys/<action>.svg              what a key shows until the plugin draws it
//   profiles/Cockpit Mini.streamDeckProfile
//                                       the six keys laid out on a Stream Deck Mini
//
// The profile is a zip holding one profile folder, in the format Elgato's own
// bundled profiles use; Stream Deck imports it the first time the plugin
// switches to it. Output is byte-for-byte reproducible.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PLUGIN = 'io.github.paulwagnero.claude-codex-cockpit';
const DIR = path.join(__dirname, '..', 'streamdeck', `${PLUGIN}.sdPlugin`);
const keys = require(path.join(DIR, 'keys'));
const manifest = require(path.join(DIR, 'manifest.json'));

// Stream Deck Mini: 3 columns, 2 rows; positions are "column,row".
const MINI_LAYOUT = {
  '0,0': 'claude',
  '1,0': 'codex',
  '2,0': 'request',
  '0,1': 'allow',
  '1,1': 'always',
  '2,1': 'deny',
};
const PROFILE_ID = '52B7B8CD-F8B2-4801-B58E-C7553CC158B5'; // fixed, so rebuilds don't make a second profile
const MINI_MODEL = '20GAI9901';

const keyImageFile = (action) => path.join(DIR, 'imgs', 'keys', `${action}.svg`);
const profileFile = () => path.join(DIR, `${manifest.Profiles[0].Name}.streamDeckProfile`);

// A key before the plugin draws it: the cockpit running with nothing to show.
function keyImage(action) {
  return `${keys.face(action, keys.deckView({ approvals: [], projects: [], usage: {} }, 0), 0)}\n`;
}

function profileZip() {
  const names = Object.fromEntries(manifest.Actions.map((a) => [a.UUID, a.Name]));
  const actions = {};
  for (const [pos, action] of Object.entries(MINI_LAYOUT)) {
    const uuid = `${PLUGIN}.${action}`;
    actions[pos] = {
      Name: names[uuid],
      Settings: {},
      State: 0,
      States: [{ FFamily: '', FSize: '', FStyle: '', FUnderline: '', Image: '', Title: '', TitleAlignment: '', TitleColor: '', TitleShow: '' }],
      UUID: uuid,
    };
  }
  const profile = {
    Actions: actions,
    DeviceModel: MINI_MODEL,
    InstalledByPluginUUID: PLUGIN,
    Name: 'Claude Codex Cockpit',
    PreconfiguredName: 'profiles/Cockpit Mini',
    Version: '1.0',
  };
  const folder = `${PROFILE_ID}.sdProfile/`;
  return zip([{ name: folder }, { name: `${folder}manifest.json`, data: Buffer.from(JSON.stringify(profile)) }]);
}

// A stored (uncompressed) zip with a fixed 1980-01-01 timestamp.
function zip(entries) {
  const DOS_DATE = (1 << 5) | 1;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data = Buffer.alloc(0) } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    parts.push(local, fileName, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // made by
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(fileName.length, 28);
    entry.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); // directory attribute
    entry.writeUInt32LE(offset, 42);
    central.push(entry, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

if (require.main === module) {
  for (const action of keys.ACTIONS) fs.writeFileSync(keyImageFile(action), keyImage(action));
  fs.writeFileSync(profileFile(), profileZip());
  console.log(`wrote ${keys.ACTIONS.length} key images and ${profileFile()}`);
}

module.exports = { MINI_LAYOUT, PROFILE_ID, keyImage, keyImageFile, profileZip, profileFile };

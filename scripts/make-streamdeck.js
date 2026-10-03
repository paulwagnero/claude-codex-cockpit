#!/usr/bin/env node
'use strict';
// Writes the Stream Deck plugin's generated files; run it after changing
// streamdeck/*.sdPlugin/keys.js or the layout below:
//
//   imgs/keys/<action>.svg              what a key shows until the plugin draws it
//   profiles/Cockpit Mini.streamDeckProfile
//                                       all six keys on a Stream Deck Mini
//   profiles/Cockpit Mini Top Row.streamDeckProfile
//                                       the top row only, the bottom row left free
//
// A profile is a zip holding one profile folder, in the format Elgato's own
// bundled profiles use; Stream Deck imports it the first time the plugin
// switches to it, or when the file is opened. Output is byte-for-byte
// reproducible.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PLUGIN = 'io.github.paulwagnero.claude-codex-cockpit';
const DIR = path.join(__dirname, '..', 'streamdeck', `${PLUGIN}.sdPlugin`);
const keys = require(path.join(DIR, 'keys'));
const manifest = require(path.join(DIR, 'manifest.json'));

// Stream Deck Mini: 3 columns, 2 rows; positions are "column,row". Ids are
// fixed, so a rebuild doesn't make a second copy of a profile.
const PROFILES = [
  {
    file: 'profiles/Cockpit Mini',
    name: 'Claude Codex Cockpit',
    id: '52B7B8CD-F8B2-4801-B58E-C7553CC158B5',
    layout: { '0,0': 'claude', '1,0': 'codex', '2,0': 'request', '0,1': 'allow', '1,1': 'always', '2,1': 'deny' },
  },
  {
    // The usage keys answer: the one whose tool is next in line glows, and a
    // press allows once.
    file: 'profiles/Cockpit Mini Top Row',
    name: 'Claude Codex Cockpit (top row)',
    id: 'AABEC650-2534-4EA9-8096-358CC77B20E7',
    layout: { '0,0': 'claude-allow', '1,0': 'codex-allow', '2,0': 'request' },
  },
];
const MINI_MODEL = '20GAI9901';

const keyImageFile = (action) => path.join(DIR, 'imgs', 'keys', `${action}.svg`);
const profileFile = (profile) => path.join(DIR, `${profile.file}.streamDeckProfile`);

// A key before the plugin draws it: the cockpit running with nothing to show.
function keyImage(action) {
  return `${keys.face(action, keys.deckView({ approvals: [], projects: [], usage: {} }, 0), 0)}\n`;
}

function profileZip(p) {
  const names = Object.fromEntries(manifest.Actions.map((a) => [a.UUID, a.Name]));
  const actions = {};
  for (const [pos, action] of Object.entries(p.layout)) {
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
    Name: p.name,
    PreconfiguredName: p.file,
    Version: '1.0',
  };
  const folder = `${p.id}.sdProfile/`;
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
  for (const p of PROFILES) fs.writeFileSync(profileFile(p), profileZip(p));
  console.log(`wrote ${keys.ACTIONS.length} key images and ${PROFILES.length} profiles`);
}

module.exports = { PROFILES, keyImage, keyImageFile, profileZip, profileFile };

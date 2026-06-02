import crypto from 'node:crypto';

const VERSION = '001';
const VERSION_LENGTH = 3;
const APP_ID_LENGTH = 24;

export const privileges = {
  PrivPublishStream: 0,
  privPublishAudioStream: 1,
  privPublishVideoStream: 2,
  privPublishDataStream: 3,
  PrivSubscribeStream: 4,
};

function randomUInt32() {
  return crypto.randomBytes(4).readUInt32LE(0);
}

function encodeHMac(key, message) {
  return crypto.createHmac('sha256', key).update(message).digest();
}

function ByteBuf() {
  const that = {
    buffer: Buffer.alloc(4096),
    position: 0,
  };

  that.pack = function pack() {
    const out = Buffer.alloc(that.position);
    that.buffer.copy(out, 0, 0, out.length);
    return out;
  };

  that.putUint16 = function putUint16(value) {
    that.buffer.writeUInt16LE(Number(value), that.position);
    that.position += 2;
    return that;
  };

  that.putUint32 = function putUint32(value) {
    that.buffer.writeUInt32LE(Number(value), that.position);
    that.position += 4;
    return that;
  };

  that.putBytes = function putBytes(bytes) {
    that.putUint16(bytes.length);
    bytes.copy(that.buffer, that.position);
    that.position += bytes.length;
    return that;
  };

  that.putString = function putString(str) {
    return that.putBytes(Buffer.from(String(str)));
  };

  that.putTreeMapUInt32 = function putTreeMapUInt32(map) {
    const entries = Object.entries(map || {});
    that.putUint16(entries.length);

    for (const [key, value] of entries) {
      that.putUint16(Number(key));
      that.putUint32(Number(value));
    }

    return that;
  };

  return that;
}

function ReadByteBuf(bytes) {
  const that = {
    buffer: bytes,
    position: 0,
  };

  that.getUint16 = function getUint16() {
    const ret = that.buffer.readUInt16LE(that.position);
    that.position += 2;
    return ret;
  };

  that.getUint32 = function getUint32() {
    const ret = that.buffer.readUInt32LE(that.position);
    that.position += 4;
    return ret;
  };

  that.getString = function getString() {
    const len = that.getUint16();
    const out = Buffer.alloc(len);
    that.buffer.copy(out, 0, that.position, that.position + len);
    that.position += len;
    return out;
  };

  that.getTreeMapUInt32 = function getTreeMapUInt32() {
    const map = {};
    const len = that.getUint16();
    for (let i = 0; i < len; i += 1) {
      const key = that.getUint16();
      const value = that.getUint32();
      map[key] = value;
    }
    return map;
  };

  return that;
}

export function AccessToken(appID, appKey, roomID, userID) {
  const token = this;
  this.appID = appID;
  this.appKey = appKey;
  this.roomID = roomID;
  this.userID = userID;
  this.issuedAt = Math.floor(Date.now() / 1000);
  this.nonce = randomUInt32();
  this.expireAt = 0;
  this.privileges = {};

  this.addPrivilege = function addPrivilege(privilege, expireTimestamp) {
    if (token.privileges === undefined) {
      token.privileges = {};
    }

    token.privileges[privilege] = expireTimestamp;

    if (privilege === privileges.PrivPublishStream) {
      token.privileges[privileges.privPublishVideoStream] = expireTimestamp;
      token.privileges[privileges.privPublishAudioStream] = expireTimestamp;
      token.privileges[privileges.privPublishDataStream] = expireTimestamp;
    }
  };

  this.expireTime = function expireTime(expireTimestamp) {
    token.expireAt = expireTimestamp;
  };

  this.packMsg = function packMsg() {
    const bufM = new ByteBuf();
    bufM.putUint32(token.nonce);
    bufM.putUint32(token.issuedAt);
    bufM.putUint32(token.expireAt);
    bufM.putString(token.roomID);
    bufM.putString(token.userID);
    bufM.putTreeMapUInt32(token.privileges);
    return bufM.pack();
  };

  this.serialize = function serialize() {
    const bytesM = this.packMsg();
    const signature = encodeHMac(token.appKey, bytesM);
    const content = new ByteBuf().putBytes(bytesM).putBytes(signature).pack();
    return VERSION + token.appID + content.toString('base64');
  };

  this.verify = function verify(key) {
    if (token.expireAt > 0 && Math.floor(Date.now() / 1000) > token.expireAt) {
      return false;
    }

    token.appKey = key;
    return encodeHMac(token.appKey, this.packMsg()).toString() === token.signature;
  };
}

export function Parse(raw) {
  try {
    if (raw.length <= VERSION_LENGTH + APP_ID_LENGTH) {
      return undefined;
    }
    if (raw.slice(0, VERSION_LENGTH) !== VERSION) {
      return undefined;
    }

    const token = new AccessToken('', '', '', '');
    token.appID = raw.slice(VERSION_LENGTH, VERSION_LENGTH + APP_ID_LENGTH);

    const contentBuf = Buffer.from(raw.slice(VERSION_LENGTH + APP_ID_LENGTH), 'base64');
    const readbuf = new ReadByteBuf(contentBuf);

    const msg = readbuf.getString();
    token.signature = readbuf.getString().toString();

    const msgBuf = new ReadByteBuf(msg);
    token.nonce = msgBuf.getUint32();
    token.issuedAt = msgBuf.getUint32();
    token.expireAt = msgBuf.getUint32();
    token.roomID = msgBuf.getString().toString();
    token.userID = msgBuf.getString().toString();
    token.privileges = msgBuf.getTreeMapUInt32();

    return token;
  } catch (error) {
    console.error(error);
    return undefined;
  }
}

export function generateRtcToken({
  appId,
  appKey,
  roomId,
  userId,
  expireInSeconds = 7200,
}) {
  const expireTimestamp = Math.floor(Date.now() / 1000) + Number(expireInSeconds);
  const key = new AccessToken(appId, appKey, roomId, userId);

  key.addPrivilege(privileges.PrivSubscribeStream, 0);
  key.addPrivilege(privileges.PrivPublishStream, expireTimestamp);
  key.expireTime(expireTimestamp);

  return {
    token: key.serialize(),
    expireTimestamp,
    privileges: {
      subscribe: 0,
      publish: expireTimestamp,
    },
  };
}

export default generateRtcToken;

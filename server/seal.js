import { scryptSync, randomBytes, createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

const FORMAT = 'fruit-stand-sealed';

// Snapshot files hold every bid, so they are encrypted with a key made from
// the host password. The host can save and restore a game without being able
// to read it by accident.
export function createSealer(password) {
  const key = scryptSync(password, 'fruit-stand-snapshot-v1', 32);
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return JSON.stringify({
        format: FORMAT,
        version: 1,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: data.toString('base64'),
      });
    },
    open(text) {
      let file;
      try {
        file = typeof text === 'string' ? JSON.parse(text) : text;
      } catch {
        throw new Error('This file is not a Fruit Stand snapshot.');
      }
      if (!file || file.format !== FORMAT) throw new Error('This file is not a Fruit Stand snapshot.');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
        const plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
        return JSON.parse(plain.toString('utf8'));
      } catch {
        throw new Error('This snapshot could not be opened. It was saved with a different host password, or the file is damaged.');
      }
    },
  };
}

export function samePassword(given, expected) {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

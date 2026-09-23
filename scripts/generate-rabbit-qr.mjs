import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';

const outputDirectory = path.resolve('docs');
const creation = {
  title: 'Airside',
  url: 'https://urfdvw.github.io/airside/#/login',
  description: 'Connect to your desktop music library and play it on this device.',
  iconUrl: 'https://raw.githubusercontent.com/urfdvw/airside/refs/heads/main/docs/favicon.svg',
  themeColor: '#d9efa1',
};

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  QRCode.toFile(path.join(outputDirectory, 'rabbit-r1-qr.png'), JSON.stringify(creation), {
    type: 'png',
    width: 1024,
    margin: 4,
    errorCorrectionLevel: 'L',
    color: { dark: '#000000', light: '#ffffff' },
  }),
  writeFile(path.join(outputDirectory, 'rabbit-r1-creation.json'), `${JSON.stringify(creation, null, 2)}\n`),
]);

console.log(`Rabbit r1 QR: ${path.join(outputDirectory, 'rabbit-r1-qr.png')}`);

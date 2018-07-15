import * as admin from 'firebase-admin';
import * as functions from 'firebase-functions';
import axios from 'axios';
import * as crypto from 'crypto';
const { spawn } = require('child-process-promise');
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
admin.initializeApp();

const Twitter = require('twitter');
const twitterClient = new Twitter({
  consumer_key: functions.config().twitter.consumer_key,
  consumer_secret: functions.config().twitter.consumer_secret,
  access_token_key: functions.config().twitter.access_token_key,
  access_token_secret: functions.config().twitter.access_token_secret
});

const boundPath = i => {
  return path.resolve(os.tmpdir(), `bound_${i}.jpg`);
};

const callTwitter = (url, arg) => {
  return new Promise<any>((res, rej) => {
    twitterClient.post(url, arg, (err, obj, _) => {
      if (err) {
        rej(err);
      } else {
        res(obj);
      }
    });
  });
};

export const fetchImage = functions.https.onRequest(
  async (request, response) => {
    const imageUrl =
      'http://weather.bangkok.go.th/FTPCustomer/radar/pics/zfiltered.jpg';
    try {
      const image = await axios.get(imageUrl, {
        responseType: 'arraybuffer'
      });
      const buffer = Buffer.from(image.data, 'binary');
      const hash = crypto.createHash('sha256');
      hash.update(buffer);
      const digest = hash.digest('hex');
      const oldDigest = (await admin
        .database()
        .ref('lastHash')
        .once('value')).val();
      console.log(oldDigest);
      if (oldDigest !== digest) {
        await admin
          .database()
          .ref('lastHash')
          .set(digest);
        const token = +new Date();
        const target = admin
          .storage()
          .bucket()
          .file(`images/radar_${token}.jpg`)
          .createWriteStream({
            metadata: {
              contentType: 'image/jpeg'
            }
          });
        target.write(buffer);
        target.end();
        const newPath = path.resolve(os.tmpdir(), 'new.jpg');
        const bgPath = path.resolve(os.tmpdir(), 'bg.jpg');
        const diffPath = path.resolve(os.tmpdir(), 'diff.jpg');
        const blobPath = path.resolve(os.tmpdir(), 'blob.jpg');
        fs.writeFileSync(newPath, buffer);
        await admin
          .storage()
          .bucket()
          .file('bg.jpg')
          .download({
            destination: bgPath
          });
        await spawn('convert', [
          newPath,
          bgPath,
          '-compose',
          'difference',
          '-composite',
          '-threshold',
          '20%',
          diffPath
        ]);
        const target2 = admin
          .storage()
          .bucket()
          .file(`images_diff/diff_${token}.jpg`)
          .createWriteStream({
            metadata: {
              contentType: 'image/jpeg'
            }
          });
        target2.write(fs.readFileSync(diffPath));
        target2.end();
        const blobResult = await spawn(
          'convert',
          [
            diffPath,
            '-define',
            'connected-components:verbose=true',
            '-connected-components',
            '8',
            blobPath
          ],
          {
            capture: ['stdout']
          }
        );
        const bounds: string = blobResult.stdout.toString();
        const boundLines = bounds
          .split('\n')
          .slice(2)
          .map(s => s.trim());
        const validBounds: number[][] = [];
        let validCount = 0;
        for (let i = 0; i <= boundLines.length - 1; i++) {
          try {
            const line = boundLines[i];
            if (line.trim() !== '') {
              const data = line.split(': ', 2)[1];
              const dimension = data.split('+', 2)[0];
              const [dimensionX, dimensionY] = dimension
                .split('x')
                .map(s => parseInt(s));
              const [originX, originY] = data
                .split(' ')[0]
                .split('+')
                .slice(1)
                .map(s => parseInt(s));
              if (dimensionX > 30 && dimensionY > 30) {
                console.log(
                  `Found blob: ${originX} ${originY} (${dimensionX}x${dimensionY})`
                );
                validBounds.push([dimensionX, dimensionY, originX, originY]);
                await spawn('convert', [
                  newPath,
                  '-fill',
                  'none',
                  '-stroke',
                  'red',
                  '-draw',
                  `rectangle ${originX},${originY} ${originX +
                    dimensionX},${originY + dimensionY}`,
                  boundPath(validCount)
                ]);
                validCount += 1;
              }
            }
          } catch (e) {
            console.log(e);
            console.log(i);
            console.log(boundLines[i]);
          }
        }
        try {
          const media = await callTwitter('media/upload', { media: buffer });

          const status = {
            media_ids: media.media_id_string
          };
          try {
            const tweet = await callTwitter('statuses/update', status);
            console.log(tweet);
            const tweetId = tweet.id_str;
            for (let i = 0; i <= validBounds.length; i++) {
              const bound = validBounds[i];
              const [dimensionX, dimensionY, originX, originY] = bound;
              const buff3 = fs.readFileSync(boundPath(i));
              try {
                const med2 = await callTwitter('media/upload', {
                  media: buff3
                });
                const status2 = {
                  media_ids: med2.media_id_string,
                  in_reply_to_status_id: tweetId,
                  status: `Rain: ${originX},${originY} ${originX +
                    dimensionX},${originY + dimensionY}`,
                  auto_populate_reply_metadata: true
                };
                try {
                  const tweet2 = await callTwitter('statuses/update', status2);
                  console.log(tweet2);
                } catch (e) {
                  console.log('Child tweet failed');
                  console.log(e);
                }

                const target3 = admin
                  .storage()
                  .bucket()
                  .file(`images_bound/${token}/bound_${i}.jpg`)
                  .createWriteStream({
                    metadata: {
                      contentType: 'image/jpeg'
                    }
                  });
                target3.write(buff3);
                target3.end();
              } catch (e) {
                console.log('Child media failed');
                console.log(e);
              }
            }
          } catch (e) {
            console.log('Main tweet failed');
            console.log(e);
          }
        } catch (e) {
          console.log('Main media failed');
          console.log(e);
        }

        response.send({ success: true }).end();
      } else {
        response.send({ success: false, reason: 'Same hash' });
      }
    } catch (e) {
      console.log(e);
      response.send({ success: false, reason: 'Cannot fetch file' }).end();
    }
  }
);

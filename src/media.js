// Field media in S3 (bucket glassfire-field-media, private). The hub signs
// short-lived URLs with its instance role; show computers download with them and
// never hold AWS credentials. Big files never pass through the hub or its tunnel.

import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const MEDIA_BUCKET = process.env.FIELD_MEDIA_BUCKET || 'glassfire-field-media';
const REGION = process.env.FIELD_MEDIA_REGION || 'us-east-1';
let client = null;
const s3 = () => (client ||= new S3Client({ region: REGION }));

// Keys are "<prefix><kit-relative path>", e.g. equip26/media/Equip Digital Signage/....mp4
export const mediaKey = (prefix, rel) => `${prefix}${rel}`;

export async function signGet(key, expiresIn = 6 * 3600) {
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }), { expiresIn });
}

// The sha256 metadata travels in the signed URL's query string; the uploader
// sends only the body (with its exact length).
export async function signPut(key, size, sha256, expiresIn = 3 * 3600) {
  return getSignedUrl(s3(), new PutObjectCommand({ Bucket: MEDIA_BUCKET, Key: key, Metadata: { sha256 } }), { expiresIn });
}

// { size, sha256 } of an object, or null when it isn't there.
export async function head(key) {
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: MEDIA_BUCKET, Key: key }));
    return { size: r.ContentLength, sha256: r.Metadata?.sha256 || '' };
  } catch (e) {
    if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
    throw e;
  }
}

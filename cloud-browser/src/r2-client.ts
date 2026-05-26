// R2 (Cloudflare S3-compatible) client for profile persistence.
//
// Object layout:  s3://<bucket>/<profile>/profile.tar.gz

import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, NoSuchKey } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import { R2, SKIP_R2 } from "./config.js";
import { log } from "./log.js";

let client: S3Client | null = null;
function s3(): S3Client {
  if (!R2) throw new Error("R2 disabled (SKIP_R2=true) — cannot use R2 client");
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: R2.endpoint,
      credentials: { accessKeyId: R2.accessKeyId, secretAccessKey: R2.secretAccessKey },
    });
  }
  return client;
}

function key(profile: string): string {
  return `${profile}/profile.tar.gz`;
}

export interface R2ProfileSummary {
  name: string;
  size: number | null;
  lastModified: Date | null;
}

// List all profiles in the bucket by enumerating top-level prefixes.
export async function listProfiles(): Promise<R2ProfileSummary[]> {
  if (SKIP_R2) return [];
  const out: R2ProfileSummary[] = [];
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({
        Bucket: R2!.bucket,
        Delimiter: "/",
        ContinuationToken: token,
      }),
    );
    for (const cp of res.CommonPrefixes ?? []) {
      if (!cp.Prefix) continue;
      const name = cp.Prefix.replace(/\/$/, "");
      // Fetch the tarball metadata to surface size + mtime
      try {
        const head = await s3().send(new HeadObjectCommand({ Bucket: R2!.bucket, Key: key(name) }));
        out.push({
          name,
          size: head.ContentLength ?? null,
          lastModified: head.LastModified ?? null,
        });
      } catch {
        out.push({ name, size: null, lastModified: null });
      }
    }
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

// True if the profile has a tarball in R2.
export async function profileExists(profile: string): Promise<boolean> {
  if (SKIP_R2) return false;
  try {
    await s3().send(new HeadObjectCommand({ Bucket: R2!.bucket, Key: key(profile) }));
    return true;
  } catch (e) {
    if (e instanceof NoSuchKey || (e as { name?: string }).name === "NotFound") return false;
    throw e;
  }
}

// Download the profile tarball as a Readable stream. Null if the profile doesn't exist.
export async function downloadProfileTarball(profile: string): Promise<Readable | null> {
  if (SKIP_R2) return null;
  try {
    const res = await s3().send(new GetObjectCommand({ Bucket: R2!.bucket, Key: key(profile) }));
    const body = res.Body;
    if (!body) return null;
    return body as Readable;
  } catch (e) {
    if (e instanceof NoSuchKey || (e as { name?: string }).name === "NoSuchKey") return null;
    throw e;
  }
}

// Upload a tarball stream to R2 under the profile's key. Returns true if it
// actually went over the wire, false if SKIP_R2 short-circuited.
export async function uploadProfileTarball(profile: string, body: Buffer): Promise<boolean> {
  if (SKIP_R2) {
    log.info("R2 disabled — skipping profile upload", { profile, bytes: body.length });
    return false;
  }
  await s3().send(
    new PutObjectCommand({
      Bucket: R2!.bucket,
      Key: key(profile),
      Body: body,
      ContentType: "application/gzip",
    }),
  );
  return true;
}

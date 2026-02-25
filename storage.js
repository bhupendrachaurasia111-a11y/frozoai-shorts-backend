import fs from 'fs';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

/**
 * Download a file from a URL and save to disk.
 */
export async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const fileStream = createWriteStream(destPath);
  await pipeline(res.body, fileStream);
}

/**
 * Upload a file buffer to Supabase Storage.
 */
export async function uploadToSupabase(supabase, bucket, storagePath, buffer, contentType) {
  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, { contentType, upsert: true });

  if (error) throw new Error(`Supabase upload failed: ${error.message}`);

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

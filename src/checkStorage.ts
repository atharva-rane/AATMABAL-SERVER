import { deletePhotos, downloadPhoto, ensureBucket, isStorageConfigured, uploadPhoto } from './services/storage';

// A tiny valid 1x1 JPEG, only used for this test.
const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
);

async function main(): Promise<void> {
  if (!isStorageConfigured) {
    console.error('SUPABASE_URL and/or SUPABASE_SERVICE_KEY are empty in server/.env');
    process.exitCode = 1;
    return;
  }

  const path = `bills/_check/${Date.now()}.jpg`;
  console.log('1/4 Checking the storage bucket...');
  await ensureBucket();
  console.log('2/4 Uploading a test file...');
  await uploadPhoto(path, TINY_JPEG, 'image/jpeg');
  console.log('3/4 Downloading it back...');
  const back = await downloadPhoto(path);
  if (!back || back.length !== TINY_JPEG.length) throw new Error('The downloaded file did not match what was uploaded.');
  console.log('4/4 Cleaning up...');
  await deletePhotos([path]);
  console.log('\nAll good. Photo storage works.');
}

main().catch((err) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});

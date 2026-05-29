const { Storage } = require('@google-cloud/storage');

const storage = new Storage();

async function readConfig() {
  const file = storage
    .bucket(process.env.GCS_BUCKET_NAME)
    .file(process.env.GCS_CONFIG_FILE_PATH);

  const [contents] = await file.download();
  return JSON.parse(contents.toString('utf8'));
}

module.exports = { readConfig };

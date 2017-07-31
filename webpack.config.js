const path = require('path');
const osjs = require('osjs-build');

module.exports = new Promise((resolve, reject) => {
  const metadataFile = path.join(__dirname, 'metadata.json');
  const options = {
    exclude: /node_modules/
  };

  osjs.webpack.createPackageConfiguration(metadataFile, options).then((result) => {
    resolve(result.config);
  }).catch(reject);
});

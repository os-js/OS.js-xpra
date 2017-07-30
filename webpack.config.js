const path = require('path');
const osjs = require('osjs-build');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = new Promise((resolve, reject) => {
  const metadataFile = path.join(__dirname, 'metadata.json');
  const options = {
    exclude: /node_modules/
  };

  osjs.webpack.createPackageConfiguration(metadataFile, options).then((result) => {
    const copy = [{
      from: 'icon.png'
    }];

    result.config.plugins.push(new CopyWebpackPlugin(copy, {
    }));

    resolve(result.config);
  }).catch(reject);
});

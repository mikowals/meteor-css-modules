Package.describe({
	name: 'nathantreid:css-modules',
	version: '1.0.0-beta.7',
	summary: 'CSS modules implementation. CSS for components!',
	git: 'https://github.com/nathantreid/meteor-css-modules.git',
	documentation: 'README.md'
});


Package.registerBuildPlugin({
	name: 'css-modules-build-plugin',
	use: [
		'babel-compiler@6.5.0-beta.12',
		'ecmascript@0.4.0-beta.12',
		'nathantreid:css-modules-import-path-helpers@0.0.1',
		'ramda:ramda@0.19.0',
	],
	npmDependencies: {
		"app-module-path": "1.0.4",
		"cjson": "0.3.3",
		"css-modules-loader-core": "1.0.0",
		"node-sass": "3.4.2",
		"postcss": "5.0.14",
		"postcss-modules-local-by-default": "1.0.1",
		"postcss-modules-extract-imports": "1.0.0",
		"postcss-modules-scope": "1.0.0",
		"postcss-modules-values": "1.1.1",
		"string-template": "1.0.0"
	},
	sources: [
		'get-output-path.js',
		'options.js',
		'postcss-plugins.js',
		'scss-processor.js',
		'css-modules-processor.js',
		'css-modules-build-plugin.js',
		'plugin.js'
	]
});

Package.onUse(function (api) {
	api.use('isobuild:compiler-plugin@1.0.0');
	api.use('isobuild:minifier-plugin@1.0.0')
});

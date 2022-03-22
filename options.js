// import { Meteor } from 'meteor/meteor';

import * as R from 'ramda';
import { createReplacer } from './text-replacer';
import { sha1 } from './utils';
import cjson from 'cjson';
import ImportPathHelpers from './helpers/import-path-helpers';
import jsonToRegex from 'json-to-regex';

import path from 'path';
import fs from 'fs';
import appModulePath from 'app-module-path';
appModulePath.addPath(ImportPathHelpers.basePath + '/node_modules/');

const optionsFilePath = path.join(ImportPathHelpers.basePath || '', 'package.json');

const pluginOptions = {};
loadOptions();
export { loadOptions as reloadOptions };
export default pluginOptions;

function getDefaultOptions() {
  return {
    cache: {
      enableCache: true,
    },
    cssClassNamingConvention: {
      replacements: []
    },
    defaultIgnorePath: 'node_modules/.*/(examples|docs|test|tests)/',
    enableDebugLog: false,
    enableProfiling: false,
    enableSassCompilation: ['scss', 'sass'],
    explicitIncludes: [],
    extensions: ['m.css', 'mss'],
    filenames: [],
    globalVariablesText: '',
    ignorePaths: [],
    includePaths: [],
    jsClassNamingConvention: {
      camelCase: false
    },
    missingClassErrorLevel: 'warn',
    missingClassIgnoreList: [],
    outputJsFilePath: '{dirname}/{basename}{extname}',
    outputCssFilePath: '{dirname}/{basename}{extname}',
    passthroughPaths: [],
    specificArchitecture: 'web',
    hash: null
  };
}

export function getHash() {
  return pluginOptions.options.hash;
}

function loadOptions() {
  let options = null;
  if (fs.existsSync(optionsFilePath)) {
    options = cjson.load(optionsFilePath).cssModules;
  }
  options = options || {};

  options = processGlobalVariables(options);
  options = R.mergeAll([getDefaultOptions(), options || {}]);

  processPluginOptions(options.postcssPlugins);

  // if (!Meteor.isDevelopment) {
  //   options.missingClassErrorLevel = false;
  // }

  options.hash = sha1(JSON.stringify(options));
  if (options.hash === pluginOptions.hash) {
    return pluginOptions.options;
  }

  processCssClassNamingConventionReplacements(options);
  options.passthroughPaths = options.passthroughPaths.map(jsonToRegex);
  options.includePaths = options.includePaths.map(jsonToRegex);
  options.ignorePaths = [options.defaultIgnorePath, ...options.ignorePaths].map(jsonToRegex);

  return pluginOptions.options = options;
}

function processCssClassNamingConventionReplacements(options) {
  if (!options.cssClassNamingConvention || !options.cssClassNamingConvention.replacements) return;

  const replacements = options.cssClassNamingConvention.replacements;
  options.cssClassNamingConvention.replacements = replacements.map(createReplacer);
}

function processGlobalVariables(options) {
  if (!options.globalVariables) return options;

  const globalVariablesText = [];
  const globalVariablesJs = [];
  options.globalVariables.forEach(entry => {
    switch (R.type(entry)) {
      case 'Object':
        globalVariablesJs.push(entry);
        globalVariablesText.push(convertJsonVariablesToScssVariables(entry));
        break;
      case 'String':
        const fileContents = fs.readFileSync(entry, 'utf-8');
        if (path.extname(entry) === '.json') {
          const jsonVariables = cjson.parse(fileContents);
          globalVariablesJs.push(jsonVariables);
          globalVariablesText.push(convertJsonVariablesToScssVariables(jsonVariables));
        } else {
          globalVariablesJs.push(convertScssVariablesToJsonVariables(fileContents));
          globalVariablesText.push(fileContents);
        }
        break;
    }
  });

  options.globalVariablesJs = R.mergeAll(globalVariablesJs);
  options.globalVariablesText = R.join('\n', globalVariablesText);
  options.globalVariablesTextLineCount = options.globalVariablesText.split(/\r\n|\r|\n/).length;

  return options;

  function convertJsonVariablesToScssVariables(variables) {
    const convertObjectToKeyValueArray = R.toPairs;
    const convertVariablesToScss = R.reduce((variables, pair) => variables + `$${pair[0]}: ${pair[1]};\n`, '');
    const processVariables = R.pipe(convertObjectToKeyValueArray, convertVariablesToScss);
    return processVariables(variables);
  }

  function convertScssVariablesToJsonVariables(text) {
    const extractVariables = R.match(/^\$.*/gm);
    const convertVariableToJson = R.pipe(R.replace(/"/g, '\\"'), R.replace(/\$(.*):\s*(.*);/g, '"$1":"$2"'));
    const surroundWithBraces = (str) => `{${str}}`;

    const processText = R.pipe(extractVariables, R.map(convertVariableToJson), R.join(',\n'), surroundWithBraces, cjson.parse);
    return processText(text);
  }
}

function processPluginOptions(plugins) {
  if (!plugins) return;

  const keys = Object.keys(plugins);
  keys.forEach(key => {
    plugins[key] = getPluginOptions(plugins[key]);
  });
}

function getPluginOptions(pluginEntry) {
  let combinedOptions = pluginEntry.inlineOptions !== undefined ? pluginEntry.inlineOptions : undefined;
  let fileOptions;
  if (R.type(pluginEntry.fileOptions) === 'Array') {
    const getFilesAsJson = R.compose(R.reduce(deepExtend, {}), R.map(R.compose(loadJsonOrMssFile, decodeFilePath)));
    fileOptions = getFilesAsJson(pluginEntry.fileOptions);
    if (Object.keys(fileOptions).length) {
      combinedOptions = deepExtend(combinedOptions || {}, fileOptions || {});
    }
  }
  return combinedOptions;
}

function loadJsonOrMssFile(filePath) {
  const removeLastOccurrence = (character, str) => {
    const index = str.lastIndexOf(character);
    return str.substring(0, index) + str.substring(index + 1);
  };
  const loadMssFile = R.compose(variables => ({ variables: variables }), cjson.parse, str => `{${str}}`, R.curry(removeLastOccurrence)(','), R.replace(/\$(.*):\s*(.*),/g, '"$1":"$2",'), R.replace(/;/g, ','), R.partialRight(fs.readFileSync, ['utf-8']));
  return filePath.endsWith('.json') ? cjson.load(filePath) : loadMssFile(filePath);
}

function decodeFilePath(filePath) {
  const match = filePath.match(/{(.*)}\/(.*)$/);
  if (!match) return filePath;

  if (match[1] === '') return match[2];

  const paths = [];

  paths[1] = paths[0] = `packages/${match[1].replace(':', '_')}/${match[2]}`;
  if (!fs.existsSync(paths[0])) {
    paths[2] = paths[0] = 'packages/' + match[1].replace(/.*:/, '') + '/' + match[2];
  }
  if (!fs.existsSync(paths[0])) {
    throw new Error(`Path not exist: ${filePath}\nTested path 1: ${paths[1]}\nTest path 2: ${paths[2]}`);
  }

  return paths[0];
}

function deepExtend(destination, source) {
  for (let property in source) {
    if (source[property] && source[property].constructor &&
      source[property].constructor === Object) {
      destination[property] = destination[property] || {};
      // eslint-disable-next-line no-caller
      arguments.callee(destination[property], source[property]);
    } else {
      destination[property] = source[property];
    }
  }
  return destination;
}

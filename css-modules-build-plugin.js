/* globals JSON */
import path from 'path';
import { MultiFileCachingCompiler } from 'meteor/caching-compiler';
import { Meteor } from 'meteor/meteor';
import { Babel } from 'meteor/babel-compiler';

import recursiveUnwrapped from 'recursive-readdir';
import ScssProcessor from './scss-processor';
import LessProcessor from './less-processor';
import StylusProcessor from './stylus-processor';
import CssModulesProcessor from './css-modules-processor';
import IncludedFile from './included-file';
import pluginOptionsWrapper, { reloadOptions } from './options';
import getOutputPath from './get-output-path';
import profile from './helpers/profile';
import ImportPathHelpers from './helpers/import-path-helpers';
import { stripIndent, stripIndents } from 'common-tags';

let pluginOptions = pluginOptionsWrapper.options;
const recursive = Meteor.wrapAsync(recursiveUnwrapped);

class FileMap extends Map {
  constructor(compiler) {
    super();
    this.compiler = compiler;
  }

  get(key) {
    const file = super.get(key);
    if (!file) {
      return;
    }
    this.compiler._prepInputFile(file);
    this.compiler.isRoot(file);
    return file;
  }
}

export default class CssModulesBuildPlugin extends MultiFileCachingCompiler {
  constructor() {
    super({
      compilerName: 'mss',
      defaultCacheSize: 1024 * 1024 * 10
    });
    this.profilingResults = {
      processFilesForTarget: null,
      _transpileScssToCss: null,
      _transpileCssModulesToCss: null
    };

    this.preprocessors = null;
    this.cssModulesProcessor = null;
    this.filesByName = null;
    this.optionsHash = null;

    this.reloadOptions = reloadOptions;
  }

  async processFilesForTarget(files) {
    pluginOptions = this.reloadOptions();
    if (!pluginOptions.cache.enableCache) {
      this._cache.reset();
    }
    this.optionsHash = pluginOptions.hash;
    const start = profile();

    this.filesByName = new FileMap(this);
    files.forEach((inputFile) => {
      const importPath = this.getAbsoluteImportPath(inputFile);
      this.filesByName.set(importPath, inputFile);
    });

    files = removeFilesFromExcludedFolders(files);
    files = addFilesFromIncludedFolders(files);

    this._setupPreprocessors();
    this.cssModulesProcessor = new CssModulesProcessor(pluginOptions, this);

    await super.processFilesForTarget(files);

    this.profilingResults.processFilesForTarget = profile(start, 'processFilesForTarget');

    function removeFilesFromExcludedFolders(files) {
      if (!pluginOptions.ignorePaths.length) {
        return files;
      }

      const testRegex = (file, regex) => regex.test(file.getPathInPackage());
      const testFile = file => testRegex.bind(this, file);
      const shouldKeepFile = file => pluginOptions.includePaths.some(testFile(file)) || !pluginOptions.ignorePaths.some(testFile(file));

      return files.filter(shouldKeepFile);
    }

    function addFilesFromIncludedFolders(files) {
      pluginOptions.explicitIncludes.map(folderPath => {
        const includedFiles = recursive(folderPath, [onlyAllowExtensionsHandledByPlugin]);
        files = files.concat(includedFiles.map(filePath => new IncludedFile(filePath.replace(/\\/g, '/'), files[0])));

        function onlyAllowExtensionsHandledByPlugin(file, stats) {
          let extension = path.extname(file);
          if (extension) {
            extension = extension.substring(1);
          }
          return !stats.isDirectory() && pluginOptions.extensions.indexOf(extension) === -1;
        }
      });
      return files;
    }
  }

  _prepInputFiles(files) {
    files.forEach(file => {
      file.referencedImportPaths = [];

      file.contents = file.getContentsAsString() || '';
      if (pluginOptions.globalVariablesText) {
        file.contents = `${pluginOptions.globalVariablesText}\n\n${file.contents}`;
      }
      file.rawContents = file.contents;
    });
  }

  _setupPreprocessors() {
    this.preprocessors = [];
    if (pluginOptions.enableSassCompilation) {
      this.preprocessors.push(new ScssProcessor(pluginOptions));
    }
    if (pluginOptions.enableStylusCompilation) {
      this.preprocessors.push(new StylusProcessor(pluginOptions));
    }
    if (pluginOptions.enableLessCompilation) {
      this.preprocessors.push(new LessProcessor(pluginOptions));
    }
  }

  isRoot(inputFile) {
    if ('isRoot' in inputFile) {
      return inputFile.isRoot;
    }

    let isRoot = null;
    for (let i = 0; i < this.preprocessors.length; i++) {
      const preprocessor = this.preprocessors[i];
      if (preprocessor.shouldProcess(inputFile)) {
        if (preprocessor.isRoot(inputFile)) {
          inputFile.preprocessor = preprocessor;
          inputFile.isRoot = true;
          return true;
        }
        isRoot = false;
      }
    }
    inputFile.isRoot = isRoot === null ? true : isRoot;
    /* If no preprocessors handle this file, it's automatically considered a root file. */
    return inputFile.isRoot;
  }

  compileOneFile(inputFile) {
    const filesByName = this.filesByName;

    this._prepInputFile(inputFile);
    this._preprocessFile(inputFile, filesByName);
    if (inputFile.transpileCssModules !== false) {
      this._transpileCssModulesToCss(inputFile, filesByName).await();
    }

    const compileResult = this._generateOutput(inputFile);
    return { compileResult, referencedImportPaths: inputFile.referencedImportPaths };
  }

  compileFromSource(source, backingInputFile, { transpileCssModules = true } = {}) {
    pluginOptions = this.reloadOptions();
    if (!pluginOptions.cache.enableCache) {
      this._cache.reset();
    }
    if (pluginOptions.enableDebugLog) {
      console.log(`***\nCompile from source: ${source}\n filename: ${backingInputFile.getPathInPackage()}`);
    }

    this.optionsHash = pluginOptions.hash;
    this._setupPreprocessors();
    this.cssModulesProcessor = new CssModulesProcessor(pluginOptions, this);

    this.filesByName = new FileMap(this);
    const inputFile = this._createIncludedFile(backingInputFile.getPathInPackage(), backingInputFile, source);

    inputFile.transpileCssModules = transpileCssModules;
    return this.compileOneFile(inputFile, this.filesByName);
  }

  _createIncludedFile(importPath, rootFile, contents) {
    const file = new IncludedFile(importPath, rootFile);
    this.getAbsoluteImportPath(file);
    file.contents = contents;
    file.prepInputFile();
    this.filesByName.set(importPath, file);

    return file;
  }

  _generateOutput(inputFile) {
    const diskCache = this._diskCache;
    const filePath = inputFile.getPathInPackage();
    const checkIfLazy = (filePath) => {
      const fileOptions = inputFile.getFileOptions();
      /**
       * If the mainModule property exists, then the mainModule config in package.json is in use, and all files should
       * be lazy-loaded.
       **/
      if (fileOptions.hasOwnProperty('mainModule')) {
        return true;
      }
      /**
       * If the lazy is true, then the it has been explicitly set in a package's addFiles command and the file should
       * be lazy-loaded.
       **/
      if (fileOptions.hasOwnProperty('lazy') && fileOptions.lazy) {
        return true;
      }

      let splitPath = filePath.split('/');
      return splitPath.indexOf('imports') >= 0 || splitPath.indexOf('node_modules') >= 0;
    };

    const isLazy = checkIfLazy(filePath);

    const compileResult = { isLazy, filePath, imports: inputFile.imports, absoluteImports: inputFile.absoluteImports };
    compileResult.stylesheet = inputFile.contents;

    compileResult.importsCode = inputFile.imports
      ? tryBabelCompile(inputFile.imports.map(importPath => `import '${importPath}';`).join('\n'))
      : '';

    const shouldAddStylesheet = inputFile.getArch().indexOf('web') === 0;
    compileResult.stylesheetCode = (isLazy && shouldAddStylesheet && inputFile.contents)
      ? tryBabelCompile(stripIndent`
         import modules from 'meteor/modules';
				 modules.addStyles(${JSON.stringify(inputFile.contents)});`)
      : '';

    compileResult.tokens = inputFile.tokens;
    const isLegacy = inputFile.getArch() === 'web.browser.legacy';
    compileResult.stylesCode = inputFile.tokens ? addMissingStylesHandler(JSON.stringify(inputFile.tokens), filePath, isLegacy) : '';
    compileResult.tokensCode = inputFile.tokens
      ? tryBabelCompile(stripIndent`
         const styles = ${compileResult.stylesCode};
         export { styles as default, styles };
         exports.__esModule = true;`, diskCache)
      : '';

    return compileResult;

    function tryBabelCompile(code) {
      try {
        return Babel.compile(code, null,  { cacheDirectory: diskCache }).code;
      } catch (err) {
        console.error(`\n/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
        console.error(`Processing Step: Babel compilation`);
        console.error(`Unable to compile ${filePath}\n${err}`);
        console.error('Source: \n// <start of file>\n', code.replace(/^\s+/gm, ''));
        console.error(`// <end of file>`);
        console.error(`\n/~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~`);
        throw err;
      }
    }

    function addMissingStylesHandler(stylesJson, filePath, isLegacy) {
      if (!isLegacy && pluginOptions.missingClassErrorLevel) {
        const logFunction = `console.${pluginOptions.missingClassErrorLevel}`;
        return `new Proxy(${stylesJson}, {
          get: function(target, name) {
            if (typeof name === 'symbol') {
              return;
            }

            var ignoredProperties = [
              'toJSON',
              'state',
              '_isVue',
              'render',
              '@@toStringTag',
              Symbol.toStringTag,
              ${(pluginOptions.missingClassIgnoreList).map(JSON.stringify).join(',')}
            ];

            return name in target
              ? target[name]
              : ignoredProperties.indexOf(name) === -1
                ? ${logFunction}(name, ': CSS module class not found in ${filePath}')
                : undefined;
          }
        })`;
      }
      return stylesJson;
    }
  }

  _prepInputFile(file) {
    if (file.isPrepped) {
      return;
    }

    file.referencedImportPaths = [];

    file.contents = file.getContentsAsString() || '';
    if (pluginOptions.globalVariablesText) {
      file.contents = `${pluginOptions.globalVariablesText}\n\n${file.contents}`;
    }
    file.rawContents = file.contents;

    file.isPrepped = true;
  }

  _preprocessFile(inputFile, filesByName) {
    if (inputFile.preprocessor) {
      inputFile.preprocessor.process(inputFile, filesByName);
    }
  }

  async _transpileCssModulesToCss(file, filesByName) {
    const startedAt = profile();

    await this.cssModulesProcessor.process(file, filesByName);

    this.profilingResults._transpileCssModulesToCss = (this.profilingResults._transpileCssModulesToCss || 0) + startedAt;
  }

  addCompileResult(file, result) {
    const isWebArchitecture = file.getArch().indexOf('web') === 0;
    const shouldAddStylesheet = isWebArchitecture && !result.isLazy;
    if (result.stylesheet && shouldAddStylesheet) {
      file.addStylesheet({
        data: result.stylesheet,
        path: getOutputPath(result.filePath, pluginOptions.outputCssFilePath) + '.css',
        sourcePath: getOutputPath(result.filePath, pluginOptions.outputCssFilePath) + '.css',
        sourceMap: JSON.stringify(result.sourceMap),
        lazy: result.isLazy
      });
    }

    const js = (result.importsCode || result.stylesheetCode || result.tokensCode)
      ? stripIndents`
					${result.importsCode}
					${isWebArchitecture ? result.stylesheetCode : ''}
					${result.tokensCode}`
      : '';

    if (js) {
      file.addJavaScript({
        data: js,
        path: getOutputPath(result.filePath, pluginOptions.outputJsFilePath) + '.js',
        sourcePath: getOutputPath(result.filePath, pluginOptions.outputJsFilePath),
        lazy: result.isLazy,
        bare: false,
      });
    }
  }

  compileResultSize(compileResult) {
    return JSON.stringify(compileResult).length;
  }

  getCacheKey(inputFile) {
    return `${this.optionsHash}...${inputFile.getSourceHash()}`;
  }

  getAbsoluteImportPath(inputFile) {
    const importPath = ImportPathHelpers.getImportPathInPackage(inputFile);
    inputFile.importPath = importPath;
    return importPath;
  }

};

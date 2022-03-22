/* globals Npm */
import path from 'path';
import format from 'string-template';

export default function getOutputPath(filePath, outputPathTemplates) {
    const template = getTemplate(filePath, outputPathTemplates);
    const extname = path.extname(filePath);

    return format(template, {
        dirname: path.dirname(filePath),
        basename: path.basename(filePath, extname),
        extname
    });
}

function getTemplate(filePath, outputPathTemplates) {
    if (typeof outputPathTemplates === 'string') {
        return outputPathTemplates;
    }

    const keys = Object.keys(outputPathTemplates);
    for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (key === 'default') continue;
        let val = outputPathTemplates[key];
        if (typeof val === 'string') {
            val = outputPathTemplates[key] = { template: val, regex: new RegExp(key) };
        }
        if (val.regex.test(filePath)) {
            return val.template;
        }
    }

    return outputPathTemplates['default'] || '{dirname}/{basename}{extname}';
}

import { existsSync, readFileSync, statSync } from "fs";
import { basename, dirname, join as joinPath, parse as parsePath } from "path";
import { TextDocument, TextEditor, window, workspace } from "vscode";

import { html as jsBeautify } from "js-beautify";
import { getExtension, getType as getMimeType } from "mime";
import * as mjml2html from "mjml";
import * as Handlebars from 'handlebars';
import * as path from 'path';

export function renderMJML(cb: (content: string) => any, fixImg?: boolean, minify?: boolean, beautify?: boolean): void {
    const activeTextEditor: TextEditor | undefined = window.activeTextEditor;
    if (!activeTextEditor) {
        return;
    }

    if (!isMJMLFile(activeTextEditor.document)) {
        window.showWarningMessage("This is not a MJML document!");

        return;
    }

    let content: string = compileContent(
        activeTextEditor.document,
        getPath(),
        minify !== undefined ? minify : workspace.getConfiguration("mjml").minifyHtmlOutput,
        beautify !== undefined ? beautify : workspace.getConfiguration("mjml").beautifyHtmlOutput
    ).html;

    if (content) {
        if (fixImg !== undefined && fixImg) {
            content = fixImages(content, getPath());
        }

        return cb(content);
    } else {
        window.showErrorMessage(`MJMLError: Failed to parse file ${basename(getPath())}`);
    }
}

export function isMJMLFile(document: TextDocument): boolean {
    return document.languageId === "mjml" && (document.uri.scheme === "file" || document.uri.scheme === "untitled");
}

export function mjmlToHtml(
    mjml: string, minify: boolean, beautify: boolean, path?: string, validation: "strict" | "soft" | "skip" = "skip"
): { html: string, errors: any[] } {
    try {
        if (!path) {
            path = getPath();
        }

        return mjml2html(mjml, {
            beautify,
            filePath: path,
            minify,
            mjmlConfigPath: getCWD(path),
            validationLevel: validation
        });
    } catch (error) {
        return { html: "", errors: [error] };
    }
}

export function fixImages(text: string, mjmlPath: string): string {
    return text.replace(
        new RegExp(/((?:src|url)(?:=|\()(?:[\'\"]|))((?!http|\\|"|#).+?)([\'\"]|\))/, "gmi"),
        (_1: string, start: string, src: string, end: string): string => {
            return start + encodeImage(joinPath(dirname(mjmlPath), src), src) + end;
        }
    );
}

export function beautifyHTML(mjml: string): string | undefined {
    try {
        const replaced: string = mjml.replace(
            new RegExp(/<.*mj-style[^>]*>(?:[^<>]+)<.*\/.*mj-style>/, "gmi"), (style: string): string => {
                return style.replace(/mj-style/gi, "style");
            }
        );

        const beautified: string = jsBeautify(replaced, workspace.getConfiguration("mjml").beautify);

        if (replaced !== mjml) {
            return beautified.replace(
                new RegExp(/<.*style[^>]*>(?:[^<>]+)<.*\/.*style>/, "gmi"), (styleBlock: string): string => {
                    return styleBlock.replace(
                        new RegExp(/<.*style.*>/, "gi"), (style: string): string => {
                            return style.replace("style", "mj-style");
                        }
                    );
                }
            );
        }

        return beautified;
    } catch (error) {

        if (error instanceof Error) {
            window.showErrorMessage(error.message);
        }
        window.showErrorMessage(String(error));
        return;
    }
}

export function getPath(): string {
    if (window.activeTextEditor && window.activeTextEditor.document) {
        return window.activeTextEditor.document.uri.fsPath;
    }

    return "";
}

function getCWD(mjmlPath?: string): string {
    if (workspace.workspaceFolders !== undefined && workspace.workspaceFolders.length > 0) {
        return workspace.workspaceFolders[0].uri.fsPath;
    }

    return (mjmlPath) ? parsePath(mjmlPath).dir : "";
}

function encodeImage(filePath: string, original: string): string {
    const mimeType: string | null = getMimeType(filePath);
    if (!mimeType) {
        return original;
    }

    const extension: string | null = getExtension(mimeType);
    if (!extension || ["bmp", "gif", "jpeg", "jpg", "png", "svg"].indexOf(extension) === -1) {
        return original;
    }

    if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
        const data: Buffer = readFileSync(filePath);
        if (data) {
            return `data:${mimeType};base64,${data.toString("base64")}`;
        }
    }

    return original;
}

export function compileContent(document: TextDocument, fsPath = document.uri.fsPath, minify = false, beautify = false, validation: "skip" | "strict" | "soft" | undefined = 'skip') {
    const text = document.getText();
    const parsedDocumentPath = path.parse(document.uri.fsPath);
    const themeFile = document.uri.fsPath.replace(parsedDocumentPath.base, 'email-theme.json');
    const themeProps = existsSync(themeFile) ? JSON.parse(readFileSync(themeFile).toString()) : {};
    const propsFile = document.uri.fsPath.replace('.mjml', '.sample.json');
    const props = existsSync(propsFile) ? JSON.parse(readFileSync(propsFile).toString()) : {};
    const finalProps = { theme: themeProps, ...props };
    Handlebars.registerHelper('include', (partial: string) => {
        const partialPath = path.resolve(parsedDocumentPath.dir, `${partial}.mjml`);
        const partialBlob = readFileSync(partialPath, 'utf8');
        const partialCompiled = Handlebars.compile(partialBlob)(finalProps);
        return new Handlebars.SafeString(partialCompiled);
    });
    Handlebars.registerHelper('ifEquals', function(arg1, arg2, options) {
        return (arg1 == arg2) ? options.fn(this) : options.inverse(this);
    });
    const compiled = Handlebars.compile(text)(finalProps);
    const { html, errors } = mjmlToHtml(compiled, minify, beautify, fsPath, validation);
    if (errors !== undefined && errors.length === 1 && errors[0].message === 'Malformed MJML. Check that your structure is correct and enclosed in <mjml> tags.') {
        // we may be trying to preview a partial, retry with wrapping it in <mjml><mj-body></mj-body></mjml>
        return mjmlToHtml(`<mjml><mj-body>${compiled}</mj-body></mjml>`, minify, beautify, fsPath, validation);
    }
    return { html, errors };
}

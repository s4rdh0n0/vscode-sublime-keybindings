import * as vscode from 'vscode';
import { readFileAsync } from './fsWrapper';
import { Mapper } from './mapper';
import { ISetting, MappedSetting, CategorizedSettings, VscodeSetting } from './settings';
import * as sublimeFolderFinder from './sublimeFolderFinder';
import * as path from 'path';

const mapper = new Mapper();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    context.subscriptions.push(vscode.commands.registerCommand('extension.importFromSublime', () => start()));
    const hasPrompted = context.globalState.get('alreadyPrompted') || false;
    if (!hasPrompted) {
        await showPrompt();
        await context.globalState.update('alreadyPrompted', true);
    }
}

async function showPrompt(): Promise<void> {
    const answer: string | undefined = await vscode.window.showInformationMessage('Would you like to customize VS Code to behave more like Sublime Text?', 'Yes', 'No');
    if (answer && answer === 'Yes') {
        start();
    }
}

async function start(): Promise<void> {
    const categorizedSettings = await getCategorizedSettings();
    if (categorizedSettings) {
        if (categorizedSettings.mappedSettings.length || categorizedSettings.defaultSettings.length) {
            const selectedSettings: VscodeSetting[] = await showPicker(categorizedSettings);
            if (selectedSettings && selectedSettings.length) {
                await importSettings(selectedSettings);
                await vscode.commands.executeCommand('workbench.action.openGlobalSettings');
            }
        } else {
            vscode.window.showInformationMessage('Nothing to import. All settings have already been imported');
        }
    }
}

async function getCategorizedSettings(): Promise<CategorizedSettings | null> {
    const settingsPath = await getSublimeFolderPath();
    if (settingsPath) {
        return getSettings(settingsPath);
    }
    return null;
}

async function getSublimeFolderPath(): Promise<string | undefined> {
    const sublimeSettingsPath = await sublimeFolderFinder.getExistingDefaultPaths();
    if (sublimeSettingsPath) {
        return sublimeSettingsPath.fsPath;
    }
    return await browsePrompt(`No Sublime settings file found at the default location: ${path.join(sublimeFolderFinder.getOSDefaultPaths()[0], sublimeFolderFinder.sublimeSettingsFilename)} `);
}

async function browsePrompt(msg: string): Promise<string | undefined> {
    const result = await vscode.window.showInformationMessage(msg, 'Browse...');
    if (result) {
        const sublimeSettingsFiles = await vscode.window.showOpenDialog({ canSelectFiles: true });
        if (sublimeSettingsFiles && sublimeSettingsFiles.length) {
            const filePath = sublimeSettingsFiles[0].fsPath;
            const isValidFilePath = await validate(filePath);
            if (isValidFilePath) {
                return filePath;
            } else {
                vscode.window.showErrorMessage(`Could not find ${sublimeFolderFinder.sublimeSettingsFilename} at ${sublimeSettingsFiles[0].fsPath} `);
            }
        }
    }
    return undefined;
}

function validate(settingsFilePath: string): boolean {
    return settingsFilePath.endsWith(sublimeFolderFinder.sublimeSettingsFilename);
}

async function getSettings(sublimeSettingsPath: string): Promise<CategorizedSettings> {
    const settings: CategorizedSettings | undefined = await mapper.getMappedSettings(await readFileAsync(sublimeSettingsPath, 'utf-8'));
    settings.mappedSettings.sort((a, b) => {
        if (a.vscode.overwritesValue && b.vscode.overwritesValue) {
            return a.sublime.name.localeCompare(b.sublime.name);
        } else if (a.vscode.overwritesValue) {
            return -1;
        } else if (b.vscode.overwritesValue) {
            return 1;
        }
        return a.sublime.name.localeCompare(b.sublime.name);
    });
    return settings;
}

interface ISettingsQuickPickItem extends vscode.QuickPickItem {
    /** Used to map back from QuickPickItem to Setting */
    setting: MappedSetting | VscodeSetting;
}

async function showPicker(settings: CategorizedSettings): Promise<VscodeSetting[]> {
    // showing mapped & default settings
    const pickedItems = await vscode.window.showQuickPick(
        [...settings.mappedSettings.map((ms) => setting2QuickPickItem(ms.vscode, ms.sublime.name)),
        ...settings.defaultSettings.map((s) => setting2QuickPickItem(s))], { canPickMany: true });
    // converting all selected entries to VscodeSettings
    return pickedItems ? pickedItems.map(pickItem => pickItem.setting instanceof MappedSetting ? pickItem.setting.vscode : pickItem.setting) : [];
}

function setting2QuickPickItem(setting: VscodeSetting, sublimeName?: string): ISettingsQuickPickItem {
    const icons = { exclamationPoint: '$(issue-opened)', arrowRight: '$(arrow-right)' };  // stored in var because auto-format adds spaces to hypens
    return {
        detail: setting.overwritesValue
            ? `${icons.exclamationPoint} Overwrites existing value: '${setting.oldValue}' with '${setting.value}'`
            : '',
        label: sublimeName
            ? `${sublimeName} ${icons.arrowRight} ${setting.name}`
            : `${setting.name}: ${setting.value}`,
        picked: !setting.overwritesValue,
        setting,
    };
}

async function importSettings(settings: ISetting[]): Promise<void> {
    return vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Importing Settings',
    }, async (progress) => {
        progress.report({ increment: 0 });
        const incrementSize = 100.0 / settings.length;
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration();
        for (const setting of settings) {
            try {
                await config.update(setting.name, setting.value, vscode.ConfigurationTarget.Global);
                progress.report({ increment: incrementSize, message: setting.name });
            } catch (e) {
                vscode.window.showErrorMessage(e.message);
                return;
            }
        }
    });
}

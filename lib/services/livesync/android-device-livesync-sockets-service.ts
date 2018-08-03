import { DeviceAndroidDebugBridge } from "../../common/mobile/android/device-android-debug-bridge";
import { AndroidDeviceHashService } from "../../common/mobile/android/android-device-hash-service";
import { DeviceLiveSyncServiceBase } from "./device-livesync-service-base";
import { APP_FOLDER_NAME } from "../../constants";
import { LiveSyncPaths } from "../../common/constants";
import { AndroidLivesyncTool } from "./android-livesync-tool";
import * as path from "path";
import * as temp from "temp";

export class AndroidDeviceSocketsLiveSyncService extends DeviceLiveSyncServiceBase implements IAndroidNativeScriptDeviceLiveSyncService, INativeScriptDeviceLiveSyncService {
	private livesyncTool: IAndroidLivesyncTool;
	private static STATUS_UPDATE_INTERVAL = 10000;

	constructor(
		private data: IProjectData,
		private $injector: IInjector,
		protected $platformsData: IPlatformsData,
		protected $staticConfig: Config.IStaticConfig,
		private $logger: ILogger,
		protected device: Mobile.IAndroidDevice,
		private $options: ICommonOptions,
		private $processService: IProcessService,
		private $fs: IFileSystem,
		private $projectFilesManager: IProjectFilesManager) {
		super($platformsData, device);
		this.livesyncTool = this.$injector.resolve(AndroidLivesyncTool);
	}

	public async beforeLiveSyncAction(deviceAppData: Mobile.IDeviceAppData): Promise<void> {
		const platformData = this.$platformsData.getPlatformData(deviceAppData.platform, this.data);
		const projectFilesPath = path.join(platformData.appDestinationDirectoryPath, APP_FOLDER_NAME);
		const pathToLiveSyncFile = temp.path({ prefix: "livesync" });
		this.$fs.writeFile(pathToLiveSyncFile, "");
		await this.device.fileSystem.putFile(pathToLiveSyncFile, this.getPathToLiveSyncFileOnDevice(deviceAppData.appIdentifier), deviceAppData.appIdentifier);
		await this.device.applicationManager.startApplication({ appId: deviceAppData.appIdentifier, projectName: this.data.projectName });
		await this.connectLivesyncTool(projectFilesPath, this.data.projectId);
	}

	private getPathToLiveSyncFileOnDevice(appIdentifier: string): string {
		return `${LiveSyncPaths.ANDROID_TMP_DIR_NAME}/${appIdentifier}-livesync-in-progress`;
	}

	public async finalizeSync(liveSyncInfo: ILiveSyncResultInfo, projectData: IProjectData): Promise<IAndroidLivesyncSyncOperationResult> {
		try {
			const result = await this.doSync(liveSyncInfo, projectData);
			return result;
		} finally {
			this.livesyncTool.end();
		}
	}

	private async doSync(liveSyncInfo: ILiveSyncResultInfo, projectData: IProjectData): Promise<IAndroidLivesyncSyncOperationResult> {
		const operationId = this.livesyncTool.generateOperationIdentifier();

		let result = { operationId, didRefresh: true };

		if (liveSyncInfo.modifiedFilesData.length) {
			const canExecuteFastSync = !liveSyncInfo.isFullSync && this.canExecuteFastSyncForPaths(liveSyncInfo.modifiedFilesData, projectData, this.device.deviceInfo.platform);
			const doSyncPromise = this.livesyncTool.sendDoSyncOperation(canExecuteFastSync, null, operationId);

			const syncInterval: NodeJS.Timer = setInterval(() => {
				if (this.livesyncTool.isOperationInProgress(operationId)) {
					this.$logger.info("Sync operation in progress...");
				}
			}, AndroidDeviceSocketsLiveSyncService.STATUS_UPDATE_INTERVAL);

			const actionOnEnd = async () => {
				clearInterval(syncInterval);
				await this.device.fileSystem.deleteFile(this.getPathToLiveSyncFileOnDevice(liveSyncInfo.deviceAppData.appIdentifier), liveSyncInfo.deviceAppData.appIdentifier);
			};

			this.$processService.attachToProcessExitSignals(this, actionOnEnd);
			// We need to clear resources when the action fails
			// But we also need the real result of the action.
			await doSyncPromise.then(actionOnEnd.bind(this), actionOnEnd.bind(this));

			result = await doSyncPromise;
			await this.getDeviceHashService(liveSyncInfo.deviceAppData.appIdentifier).updateHashes(liveSyncInfo.modifiedFilesData, true);
		} else {
			await this.device.fileSystem.deleteFile(this.getPathToLiveSyncFileOnDevice(liveSyncInfo.deviceAppData.appIdentifier), liveSyncInfo.deviceAppData.appIdentifier);
		}

		return result;
	}

	public async refreshApplication(projectData: IProjectData, liveSyncInfo: IAndroidLiveSyncResultInfo) {
		const canExecuteFastSync = !liveSyncInfo.isFullSync && this.canExecuteFastSyncForPaths(liveSyncInfo.modifiedFilesData, projectData, this.device.deviceInfo.platform);
		if (!canExecuteFastSync || !liveSyncInfo.didRefresh) {
			await this.device.applicationManager.restartApplication({ appId: liveSyncInfo.deviceAppData.appIdentifier, projectName: projectData.projectName });
		}
	}

	public async removeFiles(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[], projectFilesPath: string): Promise<void> {
		await this.livesyncTool.removeFiles(_.map(localToDevicePaths, (element: any) => element.getLocalPath()));
	}

	public async transferFiles(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[], projectFilesPath: string, isFullSync: boolean): Promise<Mobile.ILocalToDevicePathData[]> {
		let transferredFiles;

		if (isFullSync) {
			transferredFiles = await this._transferDirectory(deviceAppData, localToDevicePaths, projectFilesPath);
		} else {
			transferredFiles = await this._transferFiles(deviceAppData, localToDevicePaths);
		}

		return transferredFiles;
	}

	private async _transferFiles(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[]): Promise<Mobile.ILocalToDevicePathData[]> {
		await this.livesyncTool.sendFiles(localToDevicePaths.map(localToDevicePathData => localToDevicePathData.getLocalPath()));

		return localToDevicePaths;
	}

	private async _transferDirectory(deviceAppData: Mobile.IDeviceAppData, localToDevicePaths: Mobile.ILocalToDevicePathData[], projectFilesPath: string): Promise<Mobile.ILocalToDevicePathData[]> {
		let transferredLocalToDevicePaths: Mobile.ILocalToDevicePathData[];
		let removedLocalToDevicePaths: Mobile.ILocalToDevicePathData[];
		const deviceHashService = this.getDeviceHashService(deviceAppData.appIdentifier);
		const oldShasums = await deviceHashService.getShasumsFromDevice();

		if (this.$options.force || !oldShasums) {
			await this.livesyncTool.sendDirectory(projectFilesPath);
			transferredLocalToDevicePaths = localToDevicePaths;
		} else {
			const currentShasums: IStringDictionary = await deviceHashService.generateHashesFromLocalToDevicePaths(localToDevicePaths);
			const changedShasums = deviceHashService.getChangedShasums(oldShasums, currentShasums);
			const missingShasums = deviceHashService.getMissingShasums(oldShasums, currentShasums);
			const changedFiles = _.keys(changedShasums);
			const filesToRemove = _.keys(missingShasums);

			if (filesToRemove.length) {
				removedLocalToDevicePaths = await this.$projectFilesManager.createLocalToDevicePaths(deviceAppData, projectFilesPath, filesToRemove, []);
				await this.removeFiles(deviceAppData, removedLocalToDevicePaths, projectFilesPath);
			}

			if (changedFiles.length) {
				await this.livesyncTool.sendFiles(changedFiles);
				transferredLocalToDevicePaths = localToDevicePaths.filter(localToDevicePathData => changedFiles.indexOf(localToDevicePathData.getLocalPath()) >= 0);
			} else {
				transferredLocalToDevicePaths = [];
			}
		}

		return [].concat(transferredLocalToDevicePaths).concat(removedLocalToDevicePaths);
	}

	private async connectLivesyncTool(projectFilesPath: string, appIdentifier: string) {
		await this.livesyncTool.connect({
			appIdentifier,
			deviceIdentifier: this.device.deviceInfo.identifier,
			appPlatformsPath: projectFilesPath
		});
	}

	public getDeviceHashService(appIdentifier: string): Mobile.IAndroidDeviceHashService {
		const adb = this.$injector.resolve(DeviceAndroidDebugBridge, { identifier: this.device.deviceInfo.identifier });
		return this.$injector.resolve(AndroidDeviceHashService, { adb, appIdentifier });
	}
}

import * as path from "path";

export type VaultFolderSelectionResult =
  | { ok: true; path: string }
  | { ok: false; reason: "outside-vault" | "vault-root" };

interface NativeFolderDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface NativeFolderDialog {
  showOpenDialog(
    parentWindow: unknown,
    options: {
      title: string;
      defaultPath: string;
      properties: string[];
    },
  ): Promise<NativeFolderDialogResult>;
}

interface OpenVaultFolderDialogOptions {
  dialog: NativeFolderDialog;
  parentWindow: unknown;
  vaultBasePath: string;
  platform: NodeJS.Platform;
  title: string;
}

export function toVaultRelativeFolderPath(
  vaultBasePath: string,
  selectedFolderPath: string,
  platform: NodeJS.Platform = process.platform,
): VaultFolderSelectionResult {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const resolvedVaultPath = pathApi.resolve(vaultBasePath);
  const resolvedSelectedPath = pathApi.resolve(selectedFolderPath);
  const relativePath = pathApi.relative(resolvedVaultPath, resolvedSelectedPath);

  if (!relativePath) {
    return { ok: false, reason: "vault-root" };
  }
  if (
    relativePath === ".."
    || relativePath.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(relativePath)
  ) {
    return { ok: false, reason: "outside-vault" };
  }

  return { ok: true, path: relativePath.replace(/\\/g, "/") };
}

export async function openVaultFolderDialog({
  dialog,
  parentWindow,
  vaultBasePath,
  platform,
  title,
}: OpenVaultFolderDialogOptions): Promise<VaultFolderSelectionResult | null> {
  const properties = platform === "darwin"
    ? ["openDirectory", "createDirectory"]
    : ["openDirectory", "dontAddToRecent"];
  const result = await dialog.showOpenDialog(parentWindow, {
    title,
    defaultPath: vaultBasePath,
    properties,
  });
  const selectedFolderPath = result.filePaths[0];

  if (result.canceled || !selectedFolderPath) {
    return null;
  }

  return toVaultRelativeFolderPath(vaultBasePath, selectedFolderPath, platform);
}

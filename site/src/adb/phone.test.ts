import { describe, expect, it } from 'vitest';
import { installFailureReason, InstallError, isServerReady, parseAppInfo } from './phone';

describe('parseAppInfo', () => {
  it('reads an installed app', () => {
    expect(parseAppInfo('    versionCode=3 minSdk=34 targetSdk=37\n    versionName=0.2.0\n')).toEqual({
      installed: true,
      versionCode: 3,
      versionName: '0.2.0',
    });
  });

  it('reports a missing app', () => {
    expect(parseAppInfo('')).toEqual({ installed: false, versionCode: null, versionName: null });
  });
});

describe('installFailureReason', () => {
  it("picks out Android's reason", () => {
    expect(installFailureReason('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Existing package signed differently]')).toBe(
      'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    );
  });

  it('falls back to the output', () => {
    expect(installFailureReason(' no space left \n')).toBe('no space left');
  });

  it('says so when there is nothing to go on', () => {
    expect(installFailureReason('')).toBe("Android didn't say why.");
  });
});

describe('InstallError', () => {
  it('asks for a removal only when that would help', () => {
    expect(new InstallError('INSTALL_FAILED_UPDATE_INCOMPATIBLE').needsUninstall).toBe(true);
    expect(new InstallError('INSTALL_FAILED_VERSION_DOWNGRADE').needsUninstall).toBe(true);
    expect(new InstallError('INSTALL_FAILED_INSUFFICIENT_STORAGE').needsUninstall).toBe(false);
  });
});

describe('isServerReady', () => {
  const log = 'usb protocol: 1\ndisplay 6 created\nlistening\n';

  it('wants the protocol and the listening line', () => {
    expect(isServerReady(log)).toBe(true);
  });

  it('copes with the line endings adb can add', () => {
    expect(isServerReady(log.replaceAll('\n', '\r\n'))).toBe(true);
  });

  it('turns down a server that is still starting', () => {
    expect(isServerReady('usb protocol: 1\n')).toBe(false);
  });

  it('turns down an older server with no USB socket', () => {
    expect(isServerReady('display 6 created\nlistening\n')).toBe(false);
  });

  it('turns down a server with another protocol', () => {
    expect(isServerReady('usb protocol: 2\nlistening\n')).toBe(false);
  });

  it('treats no output as no server', () => {
    expect(isServerReady('')).toBe(false);
  });
});

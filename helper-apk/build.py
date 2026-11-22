#!/usr/bin/env python3
"""Build a development-signed helper APK using an already-installed Android SDK."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sdk', default=os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT'))
    parser.add_argument('--api', default='34')
    parser.add_argument('--build-tools', default='34.0.0')
    args = parser.parse_args()
    if not args.sdk:
        parser.error('Set ANDROID_HOME or pass --sdk; this script does not install an SDK.')
    sdk = Path(args.sdk).resolve()
    root = Path(__file__).resolve().parent
    build = root / 'build'
    jar = sdk / 'platforms' / ('android-' + args.api) / 'android.jar'
    tools = sdk / 'build-tools' / args.build_tools
    for path in [jar, tools / 'aapt2', tools / 'd8', tools / 'zipalign', tools / 'apksigner']:
        if not path.exists():
            parser.error('Required existing tool is missing: ' + str(path))
    build.mkdir(exist_ok=True)
    for name in ['classes', 'dex']:
        p = build / name
        if p.exists():
            shutil.rmtree(p)
        p.mkdir()
    def run(*command):
        subprocess.run([str(x) for x in command], cwd=root, check=True)
    sources = sorted((root / 'src').rglob('*.java'))
    run('javac', '-source', '8', '-target', '8', '-classpath', jar, '-d', build / 'classes', *sources)
    run(tools / 'd8', '--min-api', '23', '--lib', jar, '--output', build / 'dex', *sorted((build / 'classes').rglob('*.class')))
    run(tools / 'aapt2', 'link', '-o', build / 'unsigned.apk', '--manifest', root / 'AndroidManifest.xml', '-I', jar)
    with zipfile.ZipFile(build / 'unsigned.apk', 'a', compression=zipfile.ZIP_DEFLATED) as apk:
        apk.write(build / 'dex/classes.dex', 'classes.dex')
    run(tools / 'zipalign', '-f', '4', build / 'unsigned.apk', build / 'aligned.apk')
    keystore = build / 'development.keystore'
    if not keystore.exists():
        run('keytool', '-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-alias', 'andrui-development', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=AndruiTerminal Development')
    output = build / 'andrui-helper.apk'
    run(tools / 'apksigner', 'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', output, build / 'aligned.apk')
    run(tools / 'apksigner', 'verify', output)
    print('Built and signature-verified:', output)


if __name__ == '__main__':
    main()

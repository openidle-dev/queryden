# Building QueryDen for Windows (from Linux)

This guide explains how to cross-compile QueryDen for Windows while developing on a Linux system.

## Prerequisites

You need to set up the Windows cross-compilation toolchain on your Linux machine.

### 0. Install System Dependencies (Ubuntu/Debian)
These tools are required for linking Windows binaries and handling MSVC libraries:
```bash
sudo apt-get update
sudo apt-get install lld llvm clang nsis
# Ensure the tools are available without version suffixes:
sudo ln -sf /usr/bin/llvm-lib-14 /usr/bin/llvm-lib
sudo ln -sf /usr/bin/lld-link-14 /usr/bin/lld-link
```

### 1. Install Windows Target
Add the 64-bit Windows MSVC target to your Rust installation:
```bash
rustup target add x86_64-pc-windows-msvc
```

### 2. Install cargo-xwin
`cargo-xwin` manages the Windows SDK and linker for you:
```bash
cargo install cargo-xwin
```

### 3. Install NSIS (for .exe installers)
On Ubuntu/Debian:
```bash
sudo apt-get install nsis
```

### 4. Install sccache (Optional but Recommended)
Speeds up subsequent builds by caching results:
```bash
cargo install sccache
```

## How to Build

I've added a convenience script to `package.json` to handle the build.

### Run the build:
```bash
npm run build:windows
```

### Alternative Manual Command:
```bash
npx tauri build --target x86_64-pc-windows-msvc --runner cargo-xwin
```

> [!TIP]
> If it still says "command not found", try using the absolute path to your `cargo-xwin` binary:
> ```bash
> npx tauri build --target x86_64-pc-windows-msvc --runner /home/keenan/.cargo/bin/cargo-xwin
> ```

---

## 📂 Output Files

Once the build finishes successfully, your files will be generated in:
`src-tauri/target/x86_64-pc-windows-msvc/release/`

### What you will find:
1.  **The Executable**: 
    `src-tauri/target/x86_64-pc-windows-msvc/release/queryden.exe`  
    *(Standalone app you can run directly on Windows)*
2.  **The Installer**: 
    `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/QueryDen_0.1.0_x64-setup.exe`  
    *(Setup file for users to install the app)*

---

## Troubleshooting & Notes

> [!IMPORTANT]
> **C-Linkage Issues**: Some complex dependencies might still fail due to C-linkage issues. If you encounter persistent errors, use the **GitHub Actions** workflow included in `.github/workflows/release.yml`. It uses a real Windows environment and is much more reliable.

> [!NOTE]
> If you are only getting the `.exe` and not the installer, double-check that `nsis` is properly installed on your Linux machine.

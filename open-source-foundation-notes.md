# Native Remote Desktop Foundation Review

## RustDesk evaluation

The [RustDesk client repository](https://github.com/rustdesk/rustdesk) is a mature Rust remote-desktop implementation and is a more credible foundation for the future Windows-native capture, codec, transport, and input path than recreating that subsystem inside the current WPF shell. Its project documentation identifies dedicated modules for screen capture (`libs/scrap`), platform-specific keyboard/mouse control (`libs/enigo`), video/network utilities (`libs/hbb_common`), input/video services, and rendezvous/relay mediation. The project also documents Windows build prerequisites using Rust, C++ build tools, and vcpkg packages such as libvpx, libyuv, opus, and aom. [1]

The [RustDesk server repository](https://github.com/rustdesk/rustdesk-server) provides separate rendezvous (`hbbs`) and relay (`hbbr`) executables. Its documentation describes `hbbs` default port 21116 and `hbbr` default port 21117, optional forced relay behavior, and environment/command-line configuration. [2]

## Architectural consequence

The current BeamDesk web portal and WPF host shell should remain responsible for the product-specific **one-time code, explicit view approval, explicit input approval, auditing, and revocation UX**. A production Windows native transport should be implemented either by a carefully licensed RustDesk-based integration or an equivalent proven native Rust component, rather than a new untested C# capture/codec stack.

Before incorporating any third-party source, the project must complete a license and distribution review, maintain the host’s attended-support-only consent boundaries, and test on an actual Windows build environment. This local Linux prototype cannot validate Windows desktop capture or `SendInput` behavior.

## Sources

[1]: https://github.com/rustdesk/rustdesk
[2]: https://github.com/rustdesk/rustdesk-server

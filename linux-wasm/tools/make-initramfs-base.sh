#!/bin/bash

# This script creates an initial cpio file suitable to use as a base for initramfs cpio archives.
# The reason to split it up is because mknod requires the user to be root (see sudo below).

set -e

cd "$(dirname "$0")/../patches/initramfs"

rm -rf initramfs/

mkdir -p initramfs/{bin,dev,etc,home,mnt,proc,sys,usr}
sudo mknod initramfs/dev/console c 5 1
(
    cd initramfs/
    find . -print0 | cpio --null -ov --format=newc > ../initramfs-base.cpio
)

rm -rf initramfs/

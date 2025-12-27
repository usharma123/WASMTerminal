FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt update && \
    apt install -y ca-certificates gpg wget  && \
    test -f /usr/share/doc/kitware-archive-keyring/copyright || \
        wget -O - https://apt.kitware.com/keys/kitware-archive-latest.asc 2>/dev/null | \
        gpg --dearmor - | \
        tee /usr/share/keyrings/kitware-archive-keyring.gpg >/dev/null && \
    echo 'deb [signed-by=/usr/share/keyrings/kitware-archive-keyring.gpg] https://apt.kitware.com/ubuntu/ focal main' | \
        tee /etc/apt/sources.list.d/kitware.list >/dev/null && \
    apt update && \
    test -f /usr/share/doc/kitware-archive-keyring/copyright || rm /usr/share/keyrings/kitware-archive-keyring.gpg && \
    apt install -y kitware-archive-keyring && \
    apt install -y build-essential git cmake ninja-build python3 flex bison bc rsync cpio && \
    rm -rf /var/lib/apt/lists/*

# Prevent git asking for user
# Corresponds to:
RUN git config --system user.email "you@example.com"
RUN git config --system user.name "Your Name"

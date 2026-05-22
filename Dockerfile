FROM node:20-bookworm-slim

RUN apt-get update && \
    apt-get install -y openjdk-17-jdk wget unzip && \
    apt-get clean

WORKDIR /opt/android
RUN wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip commandlinetools-linux-11076708_latest.zip -d cmdline-tools && \
    mv cmdline-tools/cmdline-tools cmdline-tools/latest && \
    rm commandlinetools-linux-11076708_latest.zip

ENV ANDROID_HOME=/opt/android
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

RUN yes | sdkmanager --licenses && \
    sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

WORKDIR /usr/src/app
COPY package*.json ./

# ✅ Fixed: use npm install (doesn't require package-lock.json)
RUN npm install --omit=dev

COPY . .

EXPOSE 3000
CMD [ "node", "server-api.js" ]

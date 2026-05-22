# Use an official Node.js 20 runtime as the base image
FROM node:20-bookworm-slim

# Install JDK 17, wget, unzip, and clean apt cache
RUN apt-get update && \
    apt-get install -y openjdk-17-jdk wget unzip && \
    apt-get clean

# Set up Android SDK directory
WORKDIR /opt/android

# Download the Android command-line tools (Linux version)
RUN wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip && \
    unzip commandlinetools-linux-11076708_latest.zip -d cmdline-tools && \
    mv cmdline-tools/cmdline-tools cmdline-tools/latest && \
    rm commandlinetools-linux-11076708_latest.zip

# Set environment variables for Android SDK
ENV ANDROID_HOME=/opt/android
ENV PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools

# Accept Android SDK licenses (non‑interactive)
RUN yes | sdkmanager --licenses

# Install essential SDK components:
#   platform-tools (adb, fastboot)
#   SDK platform for API 35 (Android 15)
#   build-tools version 35.0.0
RUN sdkmanager "platform-tools" \
               "platforms;android-35" \
               "build-tools;35.0.0"

# Create a working directory for your Node.js app
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy the rest of your application source code
COPY . .

# Expose the port your web agent listens on
EXPOSE 3000

# Command to run the web agent
CMD [ "node", "server-api.js" ]

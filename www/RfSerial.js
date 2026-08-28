import { Capacitor } from "@capacitor/core";

const logHead = "[RfSERIAL]";
const plugin = Capacitor?.Plugins?.RfSerial || (Capacitor.registerPlugin ? Capacitor.registerPlugin('RfSerial') : null);

class RfSerial extends EventTarget {
    constructor() {
        super();

        if (!plugin) {
            console.error(`${logHead} Native RfSerial plugin is not available`);
            return;
        }

        this.connected = false;
        this.openRequested = false;
        this.transmitting = false;
        this.connectionInfo = null;

        this.bitrate = 0;
        this.bytesSent = 0;
        this.bytesReceived = 0;

        this.ports = [];
        this.currentDevice = null;
        this.connectionId = null;

        this.handleDataReceived = this.handleDataReceived.bind(this);
        this.handleDeviceAttached = this.handleDeviceAttached.bind(this);
        this.handleDeviceDetached = this.handleDeviceDetached.bind(this);

        plugin.addListener("rfData", this.handleDataReceived);
        plugin.addListener("deviceAttached", this.handleDeviceAttached);
        plugin.addListener("deviceDetached", this.handleDeviceDetached);

        this.loadDevices();

        console.log(`${logHead} RfSerial initialized`);
    }

    handleDataReceived(event) {
        const data = this.hexStringToUint8Array(event.data);
        this.bytesReceived += data.length;
        this.dispatchEvent(new CustomEvent("receive", { detail: data }));
    }

    handleDeviceAttached(device) {
        const added = this.createPort(device);
        if (this.ports.some((port) => port.path === added.path)) {
            return;
        }
        this.ports.push(added);
        this.dispatchEvent(new CustomEvent("addedDevice", { detail: added }));
        console.log(`${logHead} Device attached:`, added.path);
        return added;
    }

    handleDeviceDetached(device) {
        const deviceKey = this.getDeviceKey(device);
        const removed = this.ports.find((port) => port.path === deviceKey);

        if (removed) {
            const wasConnected = this.connected && this.currentDevice?.path === deviceKey;

            if (wasConnected) {
                console.warn(`${logHead} Currently connected device detached, cleaning up connection state`);
                this.cleanupConnectionState();
                this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
            }

            this.ports = this.ports.filter((port) => port.path !== deviceKey);
            this.dispatchEvent(new CustomEvent("removedDevice", { detail: removed }));
            console.log(`${logHead} Device detached:`, removed.path);
        }
    }

    createPort(device) {
        const deviceKey = this.getDeviceKey(device);
        const displayName = this.getDisplayName(device);

        return {
            path: deviceKey,
            displayName: displayName,
            vendorId: device.vendorId,
            productId: device.productId,
            device: device,
        };
    }

    getDeviceKey(device) {
        return `capacitor-${device.deviceId}`;
    }

    getDisplayName(device) {
        if (device.product) {
            return `RFCap ${device.product}`;
        }
        if (device.manufacturer) {
            return `RFCap ${device.manufacturer}`;
        }
        return `RFCap VID:${device.vendorId} PID:${device.productId}`;
    }

    async loadDevices() {
        try {
            const result = await plugin.getDevices();
            this.ports = result.devices.map((device) => this.createPort(device));
            console.log(`${logHead} Loaded ${this.ports.length} devices`);
        } catch (error) {
            console.error(`${logHead} Error loading devices:`, error);
            this.ports = [];
        }
    }

    async requestPermissionDevice() {
        let newPermissionPort = null;

        try {
            console.log(`${logHead} Requesting USB permissions...`);
            const userSelectedPort = await plugin.requestPermission();
            if (userSelectedPort?.devices?.length === 0) {
                console.log(`${logHead} No device selected or permission denied`);
                return null;
            }
            newPermissionPort = this.handleDeviceAttached(userSelectedPort.devices[0]);
            console.log(`${logHead} Permission granted for ${newPermissionPort?.path}`);
        } catch (error) {
            console.error(`${logHead} Error requesting permission:`, error);
            return null;
        }
        return newPermissionPort;
    }

    async getDevices() {
        await this.loadDevices();
        return this.ports;
    }

    async connect(path, options) {
        const baudRate = options?.baudRate ?? 115200;

        if (this.connected) {
            console.log(`${logHead} Already connected, not connecting again`);
            return true;
        }

        this.openRequested = true;

        try {
            const device = this.ports.find((port) => port.path === path);
            if (!device) {
                console.error(`${logHead} Device not found:`, path);
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }

            const deviceId = device.device.deviceId;

            console.log(`${logHead} Connecting to device:`, deviceId, "at", baudRate, "baud");

            const result = await plugin.connect({
                deviceId: deviceId,
                baudRate: baudRate,
            });

            if (result.success) {
                this.connected = true;
                this.connectionId = path;
                this.bitrate = baudRate;
                this.bytesReceived = 0;
                this.bytesSent = 0;
                this.openRequested = false;
                this.currentDevice = device;

                console.log(`${logHead} Connection opened with ID: ${this.connectionId}, Baud: ${baudRate}`);

                this.connectionInfo = {
                    usbVendorId: device.vendorId,
                    usbProductId: device.productId,
                };

                this.dispatchEvent(new CustomEvent("connect", { detail: this.connectionInfo }));
                return true;
            } else {
                this.openRequested = false;
                console.error(`${logHead} Failed to connect:`, result.error);
                this.dispatchEvent(new CustomEvent("connect", { detail: false }));
                return false;
            }
        } catch (error) {
            console.error(`${logHead} Error connecting:`, error);
            this.openRequested = false;
            this.dispatchEvent(new CustomEvent("connect", { detail: false }));
            return false;
        }
    }

    cleanupConnectionState() {
        this.connected = false;
        this.transmitting = false;
        this.connectionId = null;
        this.bitrate = 0;
        this.connectionInfo = null;
        this.currentDevice = null;
        this.bytesSent = 0;
        this.bytesReceived = 0;
    }

    async disconnect() {
        if (!this.connected) {
            return true;
        }

        try {
            await plugin.disconnect();

            console.log(
                `${logHead} Connection with ID: ${this.connectionId} closed, Sent: ${this.bytesSent} bytes, Received: ${this.bytesReceived} bytes`,
            );

            this.cleanupConnectionState();
            this.dispatchEvent(new CustomEvent("disconnect", { detail: true }));
            return true;
        } catch (error) {
            console.error(`${logHead} Error disconnecting:`, error);
            this.cleanupConnectionState();
            this.dispatchEvent(new CustomEvent("disconnect", { detail: false }));
            return false;
        }
    }

    async send(data, callback) {
        if (!this.connected) {
            console.error(`${logHead} Failed to send data, not connected`);
            if (callback) {
                callback({ bytesSent: 0 });
            }
            return { bytesSent: 0 };
        }

        data = new Uint8Array(data);

        try {
            const hexString = this.uint8ArrayToHexString(data);
            const result = await plugin.write({ data: hexString });

            this.bytesSent += result.bytesSent;

            if (callback) {
                callback({ bytesSent: result.bytesSent });
            }
            return { bytesSent: result.bytesSent };
        } catch (error) {
            console.error(`${logHead} Error sending data:`, error);
            if (callback) {
                callback({ bytesSent: 0 });
            }
            return { bytesSent: 0 };
        }
    }

    getConnectedPort() {
        return this.currentDevice;
    }

    hexStringToUint8Array(hexString) {
        if (!hexString || hexString.length === 0) {
            return new Uint8Array(0);
        }

        const bytes = new Uint8Array(hexString.length / 2);
        for (let i = 0; i < hexString.length; i += 2) {
            bytes[i / 2] = Number.parseInt(hexString.substring(i, i + 2), 16);
        }
        return bytes;
    }

    uint8ArrayToHexString(uint8Array) {
        return Array.from(uint8Array)
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    }
}

export default RfSerial;

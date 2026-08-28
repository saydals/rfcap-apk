package org.rfcap.tabs;

import android.content.Intent;
import android.hardware.usb.UsbManager;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import org.rfcap.tabs.protocols.ble.RfBlePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RfSerialPlugin.class);
        registerPlugin(RfBlePlugin.class);

        // If started or recreated by a USB device attachment intent (choosing
        // RFCap in the system chooser), replace it with a plain launcher intent
        // BEFORE super.onCreate — otherwise Capacitor treats it as a new launch
        // and recreates the WebView (the app appears to restart).
        if (getIntent() != null
                && UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(getIntent().getAction())) {
            setIntent(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER));
        }

        super.onCreate(savedInstanceState);
    }
}

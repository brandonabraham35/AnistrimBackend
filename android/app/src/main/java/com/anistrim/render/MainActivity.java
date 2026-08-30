package com.anistrim.render;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "[ANDROID-OAUTH-TRACE]";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Log.d(TAG, "onCreate");
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        Log.d(TAG, "onNewIntent");
        setIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        String data = intent.getDataString();
        Log.d(TAG, "action=" + action);
        Log.d(TAG, "data=" + data);
        if (intent.getData() != null) {
            Log.d(TAG, "scheme=" + intent.getData().getScheme());
            Log.d(TAG, "host=" + intent.getData().getHost());
            Log.d(TAG, "query=" + intent.getData().getQuery());
        }
    }
}

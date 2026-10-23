package com.zynora.trendyipo;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/** Keeps https://noor1204.github.io/IPO/ inside the app; every other link goes to the phone's browser. */
class Client extends WebViewClient {
    private final MainActivity activity;

    Client(MainActivity activity) { this.activity = activity; }

    @Override
    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
        Uri u = r.getUrl();
        String path = u.getPath();
        if ("https".equals(u.getScheme()) && "noor1204.github.io".equals(u.getHost()) && path != null && path.startsWith("/IPO")) return false;
        activity.openOutside(u);
        return true;
    }
}

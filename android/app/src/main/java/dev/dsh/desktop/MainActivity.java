package dev.dsh.desktop;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebChromeClient.FileChooserParams;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

/**
 * Hosts an already-running dsh web server inside a WebView.
 *
 * The app never starts dsh itself and ships no runtime: it discovers nothing on
 * the phone, it only opens the URL the user pairs (which may live on a desktop
 * in the same LAN or on an EasyTier/Tailscale network). Pairing is either a pasted
 * URL or a QR code from the Linux desktop shell; see {@link Pairing}.
 */
public class MainActivity extends AppCompatActivity {
    private static final String PREFS = "dsh-desktop";
    private static final String KEY_URL = "url";
    private static final String KEY_COOKIE_NAME = "cookieName";
    private static final String KEY_COOKIE_VALUE = "cookieValue";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_CAMERA = 1002;
    private static final int REQUEST_STORAGE = 1003;

    private WebView webView;
    private View setupPanel;
    private View errorBar;
    private EditText urlInput;
    private TextView errorText;
    private TextView setupStatus;

    private String baseUrl;
    private ValueCallback<Uri[]> pendingFileCallback;
    private boolean pendingDownloadAfterStorage;
    /** HTTP status of the last main-frame response, so onPageFinished does not hide an error the server answered. */
    private int lastMainFrameStatus;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        webView = findViewById(R.id.webview);
        setupPanel = findViewById(R.id.setup_panel);
        errorBar = findViewById(R.id.error_bar);
        urlInput = findViewById(R.id.url_input);
        errorText = findViewById(R.id.error_text);
        setupStatus = findViewById(R.id.setup_status);

        configureWebView();
        wireSetupPanel();

        if (savedInstanceState == null && handlePairingIntent(getIntent())) {
            return;
        }
        restore();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handlePairingIntent(intent);
    }

    /** Configure WebView capabilities the dsh UI needs. */
    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " DSHDesktopAndroid/0.1");
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return routeNavigation(request.getUrl().toString());
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                lastMainFrameStatus = 0;
                errorBar.setVisibility(View.GONE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                onLoaded(url);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showError(getString(R.string.error_load, String.valueOf(error.getDescription())));
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, android.webkit.WebResourceResponse response) {
                if (!request.isForMainFrame()) return;
                lastMainFrameStatus = response.getStatusCode();
                if (response.getStatusCode() == 401) {
                    showError(getString(R.string.error_unauthorized));
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pendingFileCallback != null) pendingFileCallback.onReceiveValue(null);
                pendingFileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException error) {
                    pendingFileCallback = null;
                    return false;
                }
            }
        });

        webView.setDownloadListener(downloadListener());
    }

    /** Open downloads through Android's DownloadManager, keeping the session cookie. */
    private DownloadListener downloadListener() {
        return (url, userAgent, contentDisposition, mimeType, contentLength) -> {
            String fileName = URLUtil.guessFileName(url, contentDisposition, mimeType);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                pendingDownloadAfterStorage = true;
                ActivityCompat.requestPermissions(this,
                        new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, REQUEST_STORAGE);
                return;
            }
            enqueueDownload(url, userAgent, mimeType, fileName);
        };
    }

    /** Enqueue one download request. */
    private void enqueueDownload(String url, String userAgent, String mimeType, String fileName) {
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            String cookie = CookieManager.getInstance().getCookie(url);
            if (cookie != null) request.addRequestHeader("Cookie", cookie);
            if (userAgent != null) request.addRequestHeader("User-Agent", userAgent);
            if (mimeType != null) request.setMimeType(mimeType);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
            DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                Toast.makeText(this, R.string.error_download, Toast.LENGTH_LONG).show();
                return;
            }
            manager.enqueue(request);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (Exception error) {
            showError(getString(R.string.error_download) + ": " + error.getMessage());
        }
    }

    /** Wire the setup screen's buttons. */
    private void wireSetupPanel() {
        Button connect = findViewById(R.id.connect_button);
        Button scan = findViewById(R.id.scan_button);
        Button clear = findViewById(R.id.clear_button);
        connect.setOnClickListener(view -> connectTyped());
        scan.setOnClickListener(view -> startScanning());
        Button retry = findViewById(R.id.error_retry);
        retry.setOnClickListener(view -> webView.reload());
        Button errorSetup = findViewById(R.id.error_setup);
        errorSetup.setOnClickListener(view -> showSetup());
        clear.setOnClickListener(view -> new AlertDialog.Builder(this)
                .setTitle(R.string.clear_title)
                .setMessage(R.string.clear_message)
                .setPositiveButton(R.string.clear_confirm, (dialog, which) -> clearSession())
                .setNegativeButton(android.R.string.cancel, null)
                .show());
    }

    /** Load whatever is typed into the address field. */
    private void connectTyped() {
        String raw = urlInput.getText().toString().trim();
        if (raw.isEmpty()) {
            showSetupStatus(getString(R.string.setup_empty), true);
            return;
        }
        Pairing pairing = Pairing.parse(raw);
        if (pairing == null) {
            showSetupStatus(getString(R.string.setup_invalid), true);
            return;
        }
        applyPairing(pairing);
    }

    /** Ensure camera permission, then open the embedded QR scanner. */
    private void startScanning() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQUEST_CAMERA);
            return;
        }
        new IntentIntegrator(this)
                .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
                .initiateScan();
    }

    /** Apply a parsed pairing: install the cookie (if any) and load the target. */
    private void applyPairing(@NonNull Pairing pairing) {
        baseUrl = null;
        if (pairing.kind == Pairing.KIND_COOKIE) {
            installCookie(pairing.url, pairing.cookieName, pairing.cookieValue);
        }
        setSetupStatusVisible(false);
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(pairing.url);
    }

    /** Set one dsh browser-session cookie for the target authority. */
    private void installCookie(String url, String name, String value) {
        String cookie = name + "=" + value + "; Path=/; HttpOnly; Max-Age=2505600";
        CookieManager manager = CookieManager.getInstance();
        manager.setCookie(url, cookie);
        manager.flush();
    }

    /** Handle deep links ({@code dshpair://}) and scanned content. */
    private boolean handlePairingIntent(Intent intent) {
        if (intent == null) return false;
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            Uri data = intent.getData();
            Pairing pairing = Pairing.ofCookie(
                    data.getQueryParameter("url"),
                    data.getQueryParameter("name"),
                    data.getQueryParameter("value"));
            if (pairing != null) {
                applyPairing(pairing);
                return true;
            }
            String url = data.getQueryParameter("url");
            if (url != null) {
                Pairing parsed = Pairing.parse(url);
                if (parsed != null) {
                    applyPairing(parsed);
                    return true;
                }
            }
        }
        return false;
    }

    /** Restore the last paired target, or show setup. */
    private void restore() {
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, null);
        String cookieName = prefs.getString(KEY_COOKIE_NAME, null);
        String cookieValue = prefs.getString(KEY_COOKIE_VALUE, null);
        if (url == null || !Pairing.isValidHttpUrl(url)) {
            showSetup();
            return;
        }
        urlInput.setText(url);
        if (cookieName != null && cookieValue != null) installCookie(url, cookieName, cookieValue);
        CookieManager.getInstance().flush();
        baseUrl = url;
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(url);
    }

    /** Show the pairing screen. */
    private void showSetup() {
        setupPanel.setVisibility(View.VISIBLE);
        errorBar.setVisibility(View.GONE);
        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        String url = prefs.getString(KEY_URL, null);
        if (url != null) urlInput.setText(url);
    }

    /** Called for every finished main-frame load. */
    private void onLoaded(String url) {
        if (url == null || !url.startsWith("http")) return;
        String clean = Pairing.stripToken(url);
        baseUrl = clean;
        setupPanel.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        if (lastMainFrameStatus < 400) errorBar.setVisibility(View.GONE);
        if (clean != null && !clean.equals(getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null))) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, clean).apply();
        }
        // The token exchange happens in the WebView, so the cookie only exists
        // after the page loads: remember it and flush it to disk now, otherwise a
        // later cold start reopens the 401 page.
        rememberCookie(clean);
        CookieManager.getInstance().flush();
    }

    /** Record the cookie that a token exchange produced for a later cold start. */
    private void rememberCookie(String url) {
        // onResume runs before the first page exists; getCookie(null) throws on Android.
        if (url == null || url.isEmpty()) return;
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie == null) return;
        for (String part : cookie.split(";")) {
            String trimmed = part.trim();
            int at = trimmed.indexOf('=');
            if (at <= 0) continue;
            String name = trimmed.substring(0, at);
            if (!name.startsWith("dsh-auth-")) continue;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(KEY_COOKIE_NAME, name)
                    .putString(KEY_COOKIE_VALUE, trimmed.substring(at + 1))
                    .apply();
            return;
        }
    }

    /** Decide whether a navigation stays in the app or opens the browser. */
    private boolean routeNavigation(String target) {
        try {
            Uri uri = Uri.parse(target);
            String scheme = uri.getScheme();
            if (scheme == null) return true;
            if (!scheme.equalsIgnoreCase("http") && !scheme.equalsIgnoreCase("https")) {
                openExternally(target);
                return true;
            }
            if (isSameOrigin(target)) return false;
            openExternally(target);
            return true;
        } catch (Exception error) {
            return true;
        }
    }

    /** Same scheme, host and effective port as the paired target. */
    private boolean isSameOrigin(String target) {
        if (baseUrl == null) return true;
        try {
            Uri a = Uri.parse(baseUrl);
            Uri b = Uri.parse(target);
            return equal(a.getScheme(), b.getScheme())
                    && equal(a.getHost(), b.getHost())
                    && effectivePort(a) == effectivePort(b);
        } catch (Exception error) {
            return false;
        }
    }

    private static boolean equal(String left, String right) {
        return left != null && left.equals(right);
    }

    private static int effectivePort(Uri uri) {
        int port = uri.getPort();
        if (port != -1) return port;
        String scheme = uri.getScheme();
        return "https".equalsIgnoreCase(scheme) ? 443 : 80;
    }

    /** Open a link in the system browser without the app's session. */
    private void openExternally(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, R.string.error_no_browser, Toast.LENGTH_SHORT).show();
        }
    }

    private void clearSession() {
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
        webView.stopLoading();
        webView.loadUrl("about:blank");
        baseUrl = null;
        urlInput.setText("");
        showSetup();
        Toast.makeText(this, R.string.clear_done, Toast.LENGTH_SHORT).show();
    }

    private void showError(String message) {
        errorText.setText(message);
        errorBar.setVisibility(View.VISIBLE);
    }

    private void showSetupStatus(String message, boolean error) {
        setupStatus.setText(message);
        setupStatus.setTextColor(ContextCompat.getColor(this,
                error ? R.color.setup_error : R.color.setup_hint));
        setupStatus.setVisibility(View.VISIBLE);
    }

    private void setSetupStatusVisible(boolean visible) {
        setupStatus.setVisibility(visible ? View.VISIBLE : View.GONE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                pendingFileCallback = null;
            }
            return;
        }
        IntentResult result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (result != null) {
            String contents = result.getContents();
            if (contents == null) return;
            Pairing pairing = Pairing.parse(contents);
            if (pairing == null) {
                showSetupStatus(getString(R.string.setup_invalid), true);
                showSetup();
                return;
            }
            applyPairing(pairing);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startScanning();
            } else {
                showSetupStatus(getString(R.string.camera_denied), true);
            }
            return;
        }
        if (requestCode == REQUEST_STORAGE && pendingDownloadAfterStorage) {
            pendingDownloadAfterStorage = false;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                Toast.makeText(this, R.string.storage_granted_retry, Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(@NonNull MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_reload) {
            if (webView.getUrl() != null) webView.reload();
            else restore();
            return true;
        }
        if (id == R.id.action_setup) {
            showSetup();
            return true;
        }
        if (id == R.id.action_open_browser) {
            String current = webView.getUrl();
            if (current != null) openExternally(current);
            return true;
        }
        if (id == R.id.action_remember_cookie) {
            rememberCookie(webView.getUrl());
            Toast.makeText(this, R.string.cookie_saved, Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (errorBar.getVisibility() == View.VISIBLE) {
            errorBar.setVisibility(View.GONE);
            return;
        }
        if (webView.getVisibility() == View.VISIBLE && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        rememberCookie(webView.getUrl());
        CookieManager.getInstance().flush();
        webView.onPause();
        webView.pauseTimers();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.resumeTimers();
        webView.onResume();
        rememberCookie(webView.getUrl());
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.setWebChromeClient(null);
            webView.destroy();
        }
        super.onDestroy();
    }
}

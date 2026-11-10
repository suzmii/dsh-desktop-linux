package dev.dsh.desktop;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

public class PairingTest {
    private static final String COOKIE_VALUE =
            "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxOTIuMTY4LjEuMTA6NDc4MjciLCJpc3N1ZWRBdCI6MSwieHh4IjoxfQ.c2lnbmF0dXJl";

    @Test
    public void parsesPlainAndTokenizedUrls() {
        Pairing clean = Pairing.parse("http://192.168.1.10:47827/");
        assertNotNull(clean);
        assertEquals(Pairing.KIND_URL, clean.kind);
        assertEquals("http://192.168.1.10:47827/", clean.url);

        Pairing tokenized = Pairing.parse(" https://dsh.example/ui?token=abc ");
        assertNotNull(tokenized);
        assertEquals(Pairing.KIND_URL, tokenized.kind);
        assertEquals("https://dsh.example/ui?token=abc", tokenized.url);
    }

    @Test
    public void parsesDesktopCookiePayload() {
        String payload = "dsh-pair/1\n"
                + "url=http://192.168.1.10:47827/\n"
                + "name=dsh-auth-v8IrmH_Bx6qvioGAlCzlaktafDb8hYQ5HN0UyETaVuW\n"
                + "value=" + COOKIE_VALUE;
        Pairing pairing = Pairing.parse(payload);
        assertNotNull(pairing);
        assertEquals(Pairing.KIND_COOKIE, pairing.kind);
        assertEquals("http://192.168.1.10:47827/", pairing.url);
        assertEquals("dsh-auth-v8IrmH_Bx6qvioGAlCzlaktafDb8hYQ5HN0UyETaVuW", pairing.cookieName);
        assertEquals(COOKIE_VALUE, pairing.cookieValue);
    }

    @Test
    public void rejectsMalformedInput() {
        assertNull(Pairing.parse(null));
        assertNull(Pairing.parse("   "));
        assertNull(Pairing.parse("ftp://example.test/"));
        assertNull(Pairing.parse("not a url"));
        assertNull(Pairing.parse("dsh-pair/1\nurl=http://192.168.1.10:47827/\nname=not-a-cookie\nvalue=v1.x.y"));
        assertNull(Pairing.parse("dsh-pair/1\nurl=http://192.168.1.10:47827/\nname=dsh-auth-0123456789abcdef\nvalue=garbage"));
    }

    @Test
    public void stripsOnlyTheLaunchToken() {
        assertEquals("http://192.168.1.10:47827/", Pairing.stripToken("http://192.168.1.10:47827/?token=abc"));
        assertEquals("http://192.168.1.10:47827/ui?x=1", Pairing.stripToken("http://192.168.1.10:47827/ui?x=1&token=abc"));
        assertEquals("http://192.168.1.10:47827/ui?x=1", Pairing.stripToken("http://192.168.1.10:47827/ui?x=1"));
        assertEquals("http://192.168.1.10:47827/", Pairing.stripToken("http://192.168.1.10:47827/"));
    }

    @Test
    public void validatesHttpUrls() {
        assertEquals(true, Pairing.isValidHttpUrl("http://127.0.0.1:3080/"));
        assertEquals(true, Pairing.isValidHttpUrl("https://dsh.example/"));
        assertEquals(false, Pairing.isValidHttpUrl("file:///etc/passwd"));
        assertEquals(false, Pairing.isValidHttpUrl("http://"));
        assertEquals(false, Pairing.isValidHttpUrl(""));
    }
}

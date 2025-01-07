const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const async = require('async');
const colors = require('colors');

let countProfile = 0
const MAX_PARALLEL_PROFILES = 10; // Giới hạn số profile chạy đồng thời

// Hàm sleep để tạm dừng
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const failedProfiles = [];
const logoutError = [];
// Đọc danh sách profile và proxy từ file TXT
const readProfilesFromFile = () => {
    const filePath = path.join(__dirname, 'SelectedAllProfiles.txt');
    if (!fs.existsSync(filePath)) {
        console.error('File SelectedAllProfiles.txt không tồn tại.');
        process.exit(1);
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);
    return lines.map(line => {
        const parts = line.split('|');
        return { folderName: parts[0], proxy: parts[1] };
    });
};

// Kiểm tra proxy
const checkProxy = async (proxy) => {
    try {
        const agent = new HttpsProxyAgent(`http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`);
        const response = await axios.get('https://httpbin.org/ip', { httpsAgent: agent });
        console.log('Proxy hoạt động:', response.data);
        return true;
    } catch (error) {
        console.error('Lỗi proxy:', error.message);
        return false;
    }
};

// Trích xuất thông tin từ URL iframe
const extractUserData = (url) => {
    let result = '';
    const queryStartIndex = url.indexOf('query_id%3D');
    if (queryStartIndex !== -1) {
        const queryEndIndex = url.indexOf('&', queryStartIndex);
        result = 'query_id=' + url.substring(queryStartIndex + 'query_id%3D'.length, queryEndIndex === -1 ? url.length : queryEndIndex);
    } else {
        const userStartIndex = url.indexOf('user%3D');
        if (userStartIndex !== -1) {
            const userEndIndex = url.indexOf('&', userStartIndex);
            result = 'user=' + url.substring(userStartIndex + 'user%3D'.length, userEndIndex === -1 ? url.length : userEndIndex);
        }
    }
    return result.replace(/%3D/g, '=').replace(/%25/g, '%').replace(/%26/g, '&') || '0';
};

async function checkAndDismissDialog(page) {
    try {
        const dialogs = await page.$$('dialog');  // Kiểm tra tất cả các hộp thoại (dialog) đang mở

        if (dialogs.length > 0) {
            console.log("Dialog found! Đang tắt dialog...");
            for (let dialog of dialogs) {
                // Đóng tất cả các dialog nếu có
                await dialog.evaluate(dialog => dialog.close());
            }
        } else {
            console.log("Không có dialog nào mở.");
        }
    } catch (error) {
        console.error("Lỗi khi kiểm tra hoặc đóng dialog:", error.message);
    }
}
async function retryProxy(proxyHost, proxyObj, retryLimit = 10) {
    let isProxyValid = false;
    let retryCount = 0;

    // Kiểm tra proxy ban đầu
    while (!isProxyValid && retryCount < retryLimit) {
        isProxyValid = await checkProxy(proxyObj);
        if (isProxyValid) {
            console.log(`[${proxyHost}] Proxy hợp lệ.`);
            break;
        } else {
            console.error(`[${proxyHost}] Proxy không hợp lệ. Thử lại sau 30 giây...`);
            await new Promise(resolve => setTimeout(resolve, 30000)); // Chờ 30 giây
            retryCount++;
        }
    }

    if (!isProxyValid) {
        console.error(`[${proxyHost}] Proxy không hợp lệ sau ${retryLimit} lần thử. Dừng xử lý profile.`);

        // Đọc proxy từ file nếu proxy không hợp lệ
        const proxyFilePath = path.join(__dirname, 'proxy.txt');
        try {
            const proxies = await loadProxyFromFile(proxyFilePath);
            if (proxies.length === 0) {
                console.error(`[${proxyHost}] Không có proxy nào trong file proxy.txt.`);
                return;
            }

            // Chọn ngẫu nhiên một proxy từ danh sách
            const randomProxy = proxies[Math.floor(Math.random() * proxies.length)];
            console.log(`[${proxyHost}] Chọn proxy ngẫu nhiên: ${randomProxy}`);

            // Cập nhật proxyObj với proxy mới và thử lại
            proxyObj = { host: randomProxy }; // Cập nhật đối tượng proxy với proxy mới

            // Tiến hành kiểm tra lại proxy với proxy mới
            await retryProxy(proxyHost, proxyObj);  // Gọi lại hàm để thử lại
        } catch (error) {
            console.error(`[${proxyHost}] Lỗi khi đọc proxy từ file:`, error);
        }

        return;
    }

    // Tiến hành công việc khác nếu proxy hợp lệ
    console.log(`[${proxyHost}] Đã sẵn sàng để tiếp tục.`);
}
const processProfile = async ({ folderName, proxy }, { url, elementSelector, dataFilePath,showBrowser }) => {
    const retryLimit = 10; // Số lần retry tối đa khi proxy không hợp lệ

    // Tách thông tin proxy
    const proxyParts = proxy.match(/^http:\/\/([^:]+):([^@]+)@([^:]+):(\d+)$/);
    if (!proxyParts) {
        console.error(`Proxy "${proxy}" không hợp lệ.`);
        return; // Dừng ngay nếu proxy không hợp lệ
    }

    const [_, proxyUsername, proxyPassword, proxyHost, proxyPort] = proxyParts;
    const proxyObj = { host: proxyHost, port: parseInt(proxyPort, 10), username: proxyUsername, password: proxyPassword };

    retryProxy(proxyHost,proxyObj,retryLimit)

    // Xử lý profile khi proxy hợp lệ
    try {
        console.log(`[${proxyHost}] Đang xử lý profile: ${folderName}`.magenta);

        const userDataPath = path.join(__dirname, 'profiles', folderName);
        if (!fs.existsSync(userDataPath)) {
            fs.mkdirSync(userDataPath, { recursive: true });
        }
        
        const launchBrowser = async (options) => {
            return new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Timed out while launching browser'));
                }, 30000); // Thời gian chờ tối đa 30 giây

                puppeteer.launch(options).then(browser => {
                    clearTimeout(timeout);
                    resolve(browser);
                }).catch(err => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        };

        const retry = async (fn, retries = 3) => {
            for (let i = 0; i < retries; i++) {
                try {
                    return await fn();
                } catch (err) {
                    console.log(`Thử lần ${i + 1} thất bại: ${err.message}`);
                    if (i === retries - 1) throw err;
                }
            }
        };
        const proxyAuthURL = `http://${proxyHost}:${proxyPort}`;
        const head = Number(showBrowser) === 1 ? false : true;
        console.log('head: ', head);

        const browser = await retry(() => launchBrowser({
            headless: head,
            args: [
                `--proxy-server=${proxyAuthURL}`,  // Cấu hình proxy
                `--user-data-dir=${userDataPath}`, // Thư mục dữ liệu người dùng
                '--disable-notifications',
                '--disable-extensions',
                '--no-sandbox',
                '--disable-gpu',
                '--window-size=800,800',
                '--force-device-scale-factor=0.5'
            ],
            defaultViewport: { width: 800, height: 700 }
        }), 3);

        // Mở một trang trình duyệt mới
        const page = await browser.newPage();

        // Lấy danh sách tất cả cookies
        const cookies = await page.cookies();

        // Xóa tất cả cookies liên quan đến xác thực proxy (giả sử cookie xác thực có tên là 'proxy-auth-cookie')
        for (let cookie of cookies) {
            // Kiểm tra và xóa các cookie liên quan đến xác thực proxy
            if (cookie.name === 'proxy-auth-cookie' || cookie.domain === 'proxy.example.com') { // Thay đổi theo tên hoặc domain cookies proxy của bạn
                await page.deleteCookie(cookie);
            }
        }

        // Xác thực proxy (nếu cần thiết)
        if (proxyUsername && proxyPassword) {
            await page.authenticate({
                username: proxyUsername,
                password: proxyPassword
            });
            console.log(`[${proxyHost}] Đã xác thực proxy: ${proxyUsername}@${proxyHost}`);
        }

        // Điều hướng đến URL cần thiết
        await page.goto(url, { waitUntil: 'load', timeout: 60000 });


        // Thêm thông báo tên profile
        await page.evaluate((folderName) => {
            const profileLabel = document.createElement('div');
            profileLabel.style.position = 'fixed';
            profileLabel.style.top = '10px';
            profileLabel.style.right = '10px';
            profileLabel.style.padding = '10px';
            profileLabel.style.backgroundColor = '#fff';
            profileLabel.style.color = '#000';
            profileLabel.style.border = '1px solid #ccc';
            profileLabel.style.fontSize = '16px';
            profileLabel.style.fontWeight = 'bold';
            profileLabel.textContent = `Profile: ${folderName}`;
            profileLabel.style.zIndex = '9999';
            document.body.appendChild(profileLabel);
        }, folderName);

        let confirmClicked = false;
        let iframeDetected = false;
        let retryAttempts = 0;
        let reloadAttempts = 0;
        let loopAttempts = 0; // Biến đếm số lần lặp
        const maxRetries = 5; // Số lần thử click tối đa
        const maxReloads = 5; // Số lần reload tối đa
        const maxLoopAttempts = 20; // Số vòng lặp tối đa để tránh chạy vô hạn

        while (!iframeDetected) {
            try {
                loopAttempts++; // Tăng biến đếm số vòng lặp

                // Kiểm tra số lần lặp đã vượt quá giới hạn chưa
                if (loopAttempts > maxLoopAttempts) {
                    console.log(`[${proxyHost}] Đã đạt số vòng lặp tối đa (${maxLoopAttempts}). Thoát để tránh chạy vô hạn.`.bgRed);
                    if (browser && browser.isConnected()) {
                        await browser.close();
                    }
                    break; // Thoát vòng lặp
                }

                console.log(`[${proxyHost}] Đang chờ phần tử "${elementSelector}"...`);
                await page.waitForSelector(elementSelector, { visible: true });
                await new Promise(resolve => setTimeout(resolve, 2000));
                console.log(`[${proxyHost}] Tìm thấy phần tử "${elementSelector}". Đang click...`.blue);

                try {
                    await page.click(elementSelector);
                } catch (error) {
                    console.error("Error interacting with element:", error);
                    try {
                        // Reload trang
                        console.log("Đang reload trang...");
                        await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                        // Kiểm tra và đóng dialog nếu có
                        //await checkAndDismissDialog(page);
                        
                        // Tiếp tục các bước khác nếu cần
                        console.log("Đã reload và kiểm tra dialog.");

                    } catch (error) {
                        console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                    }
                }

                console.log(`[${proxyHost}] Đang chờ nút "Confirm"...`);
                await page.waitForSelector('button.Button.confirm-dialog-button.default.primary.text', { timeout: 5000 });
                await new Promise(resolve => setTimeout(resolve, 2000)); // Thêm thời gian chờ trước khi click
                console.log(`[${proxyHost}] Tìm thấy nút "Confirm". Đang click...`.blue);

                try {
                    await page.click('button.Button.confirm-dialog-button.default.primary.text');
                } catch (error) {
                    console.error("Error interacting with element:", error);
                    try {
                        // Reload trang
                        console.log("Đang reload trang...");
                        await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                        // Kiểm tra và đóng dialog nếu có
                        //await checkAndDismissDialog(page);
                        
                        // Tiếp tục các bước khác nếu cần
                        console.log("Đã reload và kiểm tra dialog.");

                    } catch (error) {
                        console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                    }
                }

                console.log(`[${proxyHost}] Chờ để kiểm tra iframe...`);
                try {
                    await page.waitForSelector('iframe', { timeout: 10000 }); // Chờ tối đa 10 giây
                    const iframe = await page.$('iframe');

                    if (iframe) {
                        console.log(`[${proxyHost}] Iframe đã xuất hiện!`.green);
                        const iframeSrc = await page.evaluate(iframe => iframe.src, iframe);
                        if (!iframeSrc || iframeSrc.trim() === '') {  // Kiểm tra iframeSrc không có dữ liệu
                            console.log(`[${proxyHost}] Src của iframe trống hoặc không hợp lệ. Reload lại trang.`.yellow);
                            try {
                                // Reload trang
                                console.log("Đang reload trang...");
                                await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                                // Kiểm tra và đóng dialog nếu có
                                //await checkAndDismissDialog(page);
                                
                                // Tiếp tục các bước khác nếu cần
                                console.log("Đã reload và kiểm tra dialog.");

                            } catch (error) {
                                console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                            }
                            retryAttempts = 0;
                            reloadAttempts++;
                            if (reloadAttempts >= maxReloads) {
                                console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                                logoutError.push(`Profile: ${folderName} - Không tìm thấy Iframe.`); // Lưu lỗi
                                if (browser && browser.isConnected()) {
                                    await browser.close();
                                }
                                break; // Thoát vòng lặp
                            }
                        } else {
                            iframeDetected = true;
                            countProfile++
                            const query_id = extractUserData(iframeSrc);
                            console.log(`[${proxyHost}] query_id của iframe: ${query_id}`.green);

                            fs.appendFileSync(dataFilePath, `${query_id}\n`, 'utf-8');
                            console.log(`[${proxyHost}] Đã ghi query_id vào file: ${dataFilePath}`.green);

                            await browser.close();
                            console.log(`[${proxyHost}] Đã đóng trình duyệt cho profile: ${folderName}`.green);
                        }
                    } else {
                        console.log(`[${proxyHost}] Iframe chưa xuất hiện. Quay lại click nút "Play".`.yellow);

                        // Kiểm tra đăng xuất
                        const loginElement = await page.$('h1');
                        if (loginElement) {
                            const textContent = await page.evaluate(element => element.textContent, loginElement);
                            if (textContent.includes('Log in to Telegram by QR Code')) {
                                console.log(`[${proxyHost}] Đã đăng xuất khỏi Telegram. Chuyển qua profile khác.`.red);
                                logoutError.push(`Profile: ${folderName} - Đã đăng xuất khỏi Telegram`); // Lưu lỗi
                                await browser.close();
                                break; // Thoát vòng lặp để chuyển qua profile khác
                            }
                        }

                        retryAttempts++;
                        if (retryAttempts >= maxRetries) {
                            console.log(`[${proxyHost}] Đã thử ${maxRetries} lần mà không thấy iframe. Reload lại trang.`.bgYellow);
                            try {
                                // Reload trang
                                console.log("Đang reload trang...");
                                await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                                // Kiểm tra và đóng dialog nếu có
                                //await checkAndDismissDialog(page);
                                
                                // Tiếp tục các bước khác nếu cần
                                console.log("Đã reload và kiểm tra dialog.");

                            } catch (error) {
                                console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                            }
                            retryAttempts = 0;
                            reloadAttempts++;

                            if (reloadAttempts >= maxReloads) {
                                console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                                logoutError.push(`Profile: ${folderName} - Không tìm thấy Iframe.`); // Lưu lỗi
                                if (browser && browser.isConnected()) {
                                    await browser.close();
                                }
                                break; // Thoát vòng lặp
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[${proxyHost}] Lỗi khi chờ iframe:`, error.message,'Reload lại trang. ');
                    try {
                        // Kiểm tra đăng xuất
                        const loginElement = await page.$('h1');
                        if (loginElement) {
                            const textContent = await page.evaluate(element => element.textContent, loginElement);
                            if (textContent.includes('Log in to Telegram by QR Code')) {
                                console.log(`[${proxyHost}] Đã đăng xuất khỏi Telegram. Chuyển qua profile khác.`.red);
                                logoutError.push(`Profile: ${folderName} - Đã đăng xuất khỏi Telegram`); // Lưu lỗi
                                await browser.close();
                                break; // Thoát vòng lặp để chuyển qua profile khác
                            }
                        }
                        // Reload trang
                        console.log("Đang reload trang...");
                        await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                        // Kiểm tra và đóng dialog nếu có
                        //await checkAndDismissDialog(page);
                        
                        // Tiếp tục các bước khác nếu cần
                        console.log("Đã reload và kiểm tra dialog.");

                    } catch (error) {
                        console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                    }
                    reloadAttempts++;
                    if (reloadAttempts >= maxReloads) {
                        console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                        if (browser && browser.isConnected()) {
                            await browser.close();
                        }
                        break; // Thoát vòng lặp
                    }
                }
            } catch (err) {
                if (err.name === 'TimeoutError') {
                    console.log(`[${proxyHost}] Nút "Confirm" không xuất hiện. Kiểm tra iframe...`.yellow);
                    try {
                        // Kiểm tra đăng xuất
                        const loginElement = await page.$('h1');
                        if (loginElement) {
                            const textContent = await page.evaluate(element => element.textContent, loginElement);
                            if (textContent.includes('Log in to Telegram by QR Code')) {
                                console.log(`[${proxyHost}] Đã đăng xuất khỏi Telegram. Chuyển qua profile khác.`.red);
                                logoutError.push(`Profile: ${folderName} - Đã đăng xuất khỏi Telegram`); // Lưu lỗi
                                await browser.close();
                                break; // Thoát vòng lặp để chuyển qua profile khác
                            }
                        }
                        await page.waitForSelector('iframe', { timeout: 10000 }); // Chờ tối đa 10 giây
                        const iframe = await page.$('iframe');
                        if (iframe) {
                            console.log(`[${proxyHost}] Iframe đã xuất hiện!`.green);
                            const iframeSrc = await page.evaluate(iframe => iframe.src, iframe);
                            if (!iframeSrc || iframeSrc.trim() === '') {  // Kiểm tra iframeSrc không có dữ liệu
                                console.log(`[${proxyHost}] Src của iframe trống hoặc không hợp lệ. Reload lại trang.`.yellow);
                                try {
                                    // Reload trang
                                    console.log("[${proxyHost}] Đang reload trang...");
                                    await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                                    // Kiểm tra và đóng dialog nếu có
                                    //await checkAndDismissDialog(page);
                                    
                                    // Tiếp tục các bước khác nếu cần
                                    console.log("[${proxyHost}] Đã reload và kiểm tra dialog.");

                                } catch (error) {
                                    console.error("[${proxyHost}] Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                                }
                                retryAttempts = 0;
                                reloadAttempts++;
                                if (reloadAttempts >= maxReloads) {
                                    console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                                    if (browser && browser.isConnected()) {
                                        await browser.close();
                                    }
                                    break; // Thoát vòng lặp
                                }
                            } else {
                                iframeDetected = true;
                                countProfile++
                                const query_id = extractUserData(iframeSrc);
                                console.log(`[${proxyHost}] query_id của iframe: ${query_id}`.green);

                                fs.appendFileSync(dataFilePath, `${query_id}\n`, 'utf-8');
                                console.log(`[${proxyHost}] Đã ghi query_id vào file: ${dataFilePath}`.green);

                                await browser.close();
                                console.log(`[${proxyHost}] Đã đóng trình duyệt cho profile: ${folderName}`.green);
                            }
                        } else {
                            console.log(`[${proxyHost}] Iframe chưa xuất hiện. Quay lại click nút "Play".`.yellow);

                            // Kiểm tra đăng xuất
                            const loginElement = await page.$('h1');
                            if (loginElement) {
                                const textContent = await page.evaluate(element => element.textContent, loginElement);
                                if (textContent.includes('Log in to Telegram by QR Code')) {
                                    console.log(`[${proxyHost}] Đã đăng xuất khỏi Telegram. Chuyển qua profile khác.`.red);
                                    logoutError.push(`Profile: ${folderName} - Đã đăng xuất khỏi Telegram`); // Lưu lỗi
                                    await browser.close();
                                    break; // Thoát vòng lặp để chuyển qua profile khác
                                }
                            }

                            retryAttempts++;
                            if (retryAttempts >= maxRetries) {
                                console.log(`[${proxyHost}] Đã thử ${maxRetries} lần mà không thấy iframe. Reload lại trang.`.bgYellow);
                                try {
                                    // Reload trang
                                    console.log("Đang reload trang...");
                                    await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                                    // Kiểm tra và đóng dialog nếu có
                                    //await checkAndDismissDialog(page);
                                    
                                    // Tiếp tục các bước khác nếu cần
                                    console.log("Đã reload và kiểm tra dialog.");

                                } catch (error) {
                                    console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                                }
                                retryAttempts = 0;
                                reloadAttempts++;

                                if (reloadAttempts >= maxReloads) {
                                    console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                                    if (browser && browser.isConnected()) {
                                        await browser.close();
                                    }
                                    break; // Thoát vòng lặp
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`[${proxyHost}] Lỗi khi chờ iframe:`, error.message,'Reload lại trang. ');
                        try {
                            // Kiểm tra đăng xuất
                            const loginElement = await page.$('h1');
                            if (loginElement) {
                                const textContent = await page.evaluate(element => element.textContent, loginElement);
                                if (textContent.includes('Log in to Telegram by QR Code')) {
                                    console.log(`[${proxyHost}] Đã đăng xuất khỏi Telegram. Chuyển qua profile khác.`.red);
                                    logoutError.push(`Profile: ${folderName} - Đã đăng xuất khỏi Telegram`); // Lưu lỗi
                                    await browser.close();
                                    break; // Thoát vòng lặp để chuyển qua profile khác
                                }
                            }
                            // Reload trang
                            console.log("Đang reload trang...");
                            await page.reload({ waitUntil: 'networkidle0' });  // Đợi khi không còn kết nối mạng nào

                            // Kiểm tra và đóng dialog nếu có
                            //await checkAndDismissDialog(page);
                            
                            // Tiếp tục các bước khác nếu cần
                            console.log("Đã reload và kiểm tra dialog.");

                        } catch (error) {
                            console.error("Lỗi khi reload hoặc kiểm tra dialog:", error.message);
                        }
                        reloadAttempts++;
                        if (reloadAttempts >= maxReloads) {
                            console.log(`[${proxyHost}] Đã reload ${maxReloads} lần mà không thấy iframe. Thoát.`.bgRed);
                            if (browser && browser.isConnected()) {
                                await browser.close();
                            }
                            break; // Thoát vòng lặp
                        }
                    }    
                } else {
                    console.error(`[${proxyHost}] Lỗi khác xảy ra:`.bgRed, err);
                    logoutError.push(`Profile: ${folderName} - Lỗi: ${err.message}`); // Lưu lỗi
                    if (browser && browser.isConnected()) {
                        await browser.close();
                    }
                    break;
                }
            }
        }

    } catch (error) { 
        if (error.message.includes('Failed to launch the browser process')) {
            console.error(`[${proxyHost}] Không thể khởi chạy trình duyệt:`, error.message);
        } else if (error.message.includes('net::ERR_INVALID_AUTH_CREDENTIALS')) {
            // Khi gặp lỗi "net::ERR_INVALID_AUTH_CREDENTIALS"
            console.error(`[${proxyHost}] Lỗi xác thực proxy: ${error.message}`);
            
            // Lưu lại thông tin vào danh sách lỗi để chạy lại sau (nếu cần thiết)
            failedProfiles.push({ folderName, proxy });

            // Tắt mở lại trình duyệt và xóa xác thực proxy
            try {
                // Đóng trình duyệt hiện tại
                await browser.close();
                console.log(`[${proxyHost}] Đã đóng trình duyệt vì lỗi xác thực proxy.`);
            } catch (closeError) {
                console.error(`[${proxyHost}] Lỗi khi đóng trình duyệt: ${closeError.message}`);
            }

            // Tiến hành lại với việc mở trình duyệt mới và xác thực proxy lại
            try {
                const newBrowser = await retry(() => launchBrowser({
                    headless: head,
                    args: [
                        `--proxy-server=${proxyAuthURL}`,  // Cấu hình proxy
                        `--user-data-dir=${userDataPath}`, // Thư mục dữ liệu người dùng
                        '--disable-notifications',
                        '--disable-extensions',
                        '--no-sandbox',
                        '--disable-gpu',
                        '--window-size=800,800',
                        '--force-device-scale-factor=0.5'
                    ],
                    defaultViewport: { width: 800, height: 700 }
                }), 3);

                console.log(`[${proxyHost}] Đã mở lại trình duyệt sau khi gặp lỗi xác thực proxy.`);

                // Mở lại trang mới hoặc tiếp tục với quy trình của bạn
                const page = await newBrowser.newPage();

                // Xác thực lại proxy (nếu cần thiết)
                if (proxyUsername && proxyPassword) {
                    await page.authenticate({
                        username: proxyUsername,
                        password: proxyPassword
                    });
                    console.log(`[${proxyHost}] Đã xác thực lại proxy: ${proxyUsername}@${proxyHost}`);
                }

                // Tiến hành điều hướng và xử lý các bước tiếp theo
                await page.goto(url, { waitUntil: 'load', timeout: 60000 });
            } catch (retryError) {
                console.error(`[${proxyHost}] Lỗi khi mở lại trình duyệt:`, retryError.message);
                // Lưu vào danh sách lỗi để thực hiện lại sau nếu cần
                failedProfiles.push({ folderName, proxy });
            }
        } else {
            // Xử lý các lỗi khác
            console.error(`[${proxyHost}] Lỗi không xác định:`, error.message);
        }
    }

};
async function retryFailedProfiles(failedProfiles, theard) {
    if (failedProfiles.length > 0) {
        console.log(`Thử lại ${failedProfiles.length} profile gặp lỗi...`);

        // Chạy lại các tác vụ với async.eachLimit để giới hạn số lượng tác vụ chạy đồng thời
        await new Promise((resolve, reject) => {
            async.eachLimit(failedProfiles, theard, async (profile) => {
                try {
                    // Xử lý lại mỗi profile bị lỗi
                    await processProfile(profile, { url, elementSelector, dataFilePath, showBrowser });
                    console.log(`[${profile.proxy}] Đã xử lý lại thành công`);
                } catch (err) {
                    console.error(`[${profile.proxy}] Xử lý lại gặp lỗi: ${err.message}`);
                }
            }, (err) => {
                if (err) {
                    reject(err); // Nếu có lỗi trong khi xử lý, reject promise
                } else {
                    resolve(); // Nếu không có lỗi, resolve promise
                }
            });
        });
    } else {
        console.log('Không có profile nào để thử lại.');
    }
}

const run = async () => {
    try{
        const gameData = fs.readFileSync('ini/select_game.txt', 'utf-8').split('\n').map(line => line.trim()).filter(Boolean);

        if (gameData.length === 0) {
            console.error('Không có dữ liệu trong file select_game.txt');
            return;
        }

        const [nameTask, url, elementSelector, dataFilePath,theard,showBrowser] = gameData[0].split('|');
        console.log('showBrowser: ',showBrowser)
        fs.writeFileSync(dataFilePath, '', 'utf-8'); // Xóa dữ liệu cũ
        const profiles = readProfilesFromFile();

        //MAX_PARALLEL_PROFILES = theard
        
        // Sử dụng async.eachLimit để giới hạn số lượng tác vụ chạy đồng thời
        await new Promise((resolve, reject) => {
            async.eachLimit(profiles, theard, async (profile) => {
                await processProfile(profile, { url, elementSelector, dataFilePath,showBrowser });
            }, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });

        await retryFailedProfiles(failedProfiles, 5); 

        if (logoutError.length > 0) {
            const bom = '\uFEFF'; // BOM cho UTF-8
            const dataWithTaskName = logoutError.map(line => `${nameTask}: ${line}`).join('\n'); // Thêm nameTask vào đầu mỗi dòng

            // Kiểm tra nếu tệp chưa tồn tại, thêm BOM
            fs.access('ini/LogOut.txt', fs.constants.F_OK, (err) => {
                const initialContent = err ? bom : ''; // Nếu tệp chưa tồn tại, thêm BOM
                const contentToAppend = initialContent + dataWithTaskName + '\n';

                // Ghi thêm dữ liệu vào file
                fs.appendFile('ini/LogOut.txt', contentToAppend, (err) => {
                    if (err) {
                        console.error('Lỗi khi ghi lỗi vào file:', err);
                    } else {
                        console.log('Đã ghi thêm lỗi vào file: ini/LogOut.txt');
                    }
                });
            });
        } else {
            console.log('Không có lỗi nào cần ghi ra file.');
        }

        console.log(`Hoàn thành ${countProfile} profile.`);
        await new Promise(resolve => setTimeout(resolve, 5000)); 
    }catch(error) {
        console.error(` Lỗi với": `, error.message);
        await new Promise(resolve => setTimeout(resolve, 5000)); 
    }
};

run();

import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const GetAppVersionInfo = async (req:any) => {
    const response = await fetchClient({
        url: SvrUri + "/api/v1/get_version_info?app_version=" + req.version + "&app=" + req.body.app,
		method: "GET",
        headers: {
            "Access-Token": req.token,
        },
    });
    if (response.code !== 0) {
        console.error("get version info error, code: " + response.code)
        return {
            lastVersion: "",
            hasVersion: false,
            isForceUpgrade: false
        }
    }
    // 响应
    return {
        lastVersion: response.data.last_version,
        hasVersion: response.data.is_less_current_version,
        isForceUpgrade: response.data.force_upgrade
    }
}

export default GetAppVersionInfo

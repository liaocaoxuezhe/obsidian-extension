import fetchClient from "../util/fetch";
import {SvrUri} from "../model/Consts";

const GetPageParseNum = async (req:any) => {
    const response = await fetchClient({
        url: SvrUri + "/api/v1/get_user_parse_page_num?source=obsidian", method: "GET",
        headers: {
            "Access-Token": req.token,
        }
    });
    if (response.code !== 0) {
        console.error("get page num error, code: " + response.code)
        return {
			total: 0,
			finished: 0
		};
    }
    // 响应
    return {
        total: response.data.total,
        finished: response.data.finished_num,
    }
}

export default GetPageParseNum
